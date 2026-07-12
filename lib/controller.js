// ChatController — one instance per tab group (= one conversation).
// Lives in the service worker: holds the OpenClaw session, agent loop and transcript.
// Side panels (sidepanel/panel.js) are thin views connected via a Port;
// thanks to this, the agent keeps working even when you browse tabs outside the group
// and the panel is hidden.

import { AgentLoop } from "./agent.js";
import { BrowserTools } from "./tools.js";
import { getPreset } from "./providers.js";

export class ChatController {
  /**
   * @param {object} deps
   *  groupId        – tab group
   *  groups         – GroupManager (sessionKey mapping, lastActiveTab)
   *  getSettings    – () => settings (cached from background)
   *  ensureBackend  – async () => ready active backend (gateway or direct)
   *  getBackend     – () => active backend or null (without connecting)
   *  getConnState   – () => {state, reason} last connection status
   *  updateBadge    – () => void (refresh approval badge)
   *  buildCatalog   – async () => {groups, active} model catalog
   *  applySelection – async ({mode, provider, model}) => switch backend/model
   */
  constructor(deps) {
    this.d = deps;
    this.groupId = deps.groupId;
    this.sessionKey = null;
    this.ports = new Set();
    this.chipSeq = 0;
    this.pendingApproval = null;    // {id, resolve, info}
    this.pendingPrefill = null;     // text to insert into input after panel opens
    this.lastActivityAt = Date.now();

    this.tools = new BrowserTools({
      groupId: this.groupId,
      getLastActiveTabId: () => this.d.groups.lastActiveTab.get(this.groupId) ?? null,
    });

    const chat = {
      sessionKey: () => this.sessionKey,
      supportsAttachments: () => this.d.getBackend()?.supportsAttachments ?? true,
      /** Timestamp of last LLM partial — agent loop uses this for stuck detection. */
      lastPartialAt: 0,
      send: async ({ text, attachments, systemMessage, ephemeral }) => {
        const be = await this.d.ensureBackend();
        this.lastActivityAt = Date.now();
        chat.lastPartialAt = Date.now();
        return be.sendAndWaitFinal({
          sessionKey: this.sessionKey,
          text, attachments, systemMessage, ephemeral,
          onPartial: (t) => {
            chat.lastPartialAt = Date.now();
            this.broadcast({ t: "partial", text: t });
          },
        });
      },
      cancel: () => this.d.getBackend()?.cancelRun(this.sessionKey),
      resetTurn: () => { this.d.getBackend()?.resetTurn?.(this.sessionKey); },
      storePermanent: (role, text) => {
        const be = this.d.getBackend();
        if (be?.kind === "direct") be.storePermanent?.(this.sessionKey, role, text);
      },
    };

    this.agent = new AgentLoop({
      chat,
      tools: this.tools,
      getSettings: this.d.getSettings,
      ui: {
        addAssistant: (text) => this.addAssistant(text),
        addChip: (label, why) => this.addChip(label, why),
        requestApproval: (info) => this.requestApproval(info),
        setWorking: (on, label) => {
          this.broadcast({ t: "working", on: !!on, label: label || "" });
          this.d.groups.updateStatus(this.groupId, on ? "working" : "idle", label || "");
        },
        systemNote: (text, opts) => this.systemNote(text, opts),
        addScreenshotThumb: (dataUrl) => this.broadcast({ t: "shot", dataUrl }),
        setProgressLabel: (label) => this.d.groups.updateProgressLabel(this.groupId, label),
      },
    });
  }

  async init() {
    this.sessionKey = await this.d.groups.getSessionKey(this.groupId);
    if (!this.sessionKey) {
      this.sessionKey = makeSessionKey();
      await this.d.groups.setSessionKey(this.groupId, this.sessionKey);
    } else {
      this.agent.markPreambleSent(this.sessionKey); // existing session already had the preamble
    }
    return this;
  }

  // ------------------------------------------------------------- transcript

  async loadTranscripts() {
    const { transcripts = {} } = await chrome.storage.local.get("transcripts");
    return transcripts;
  }

  async persist(entry) {
    if (!this.sessionKey) return;
    const transcripts = await this.loadTranscripts();
    const t = transcripts[this.sessionKey] || { title: "", updatedAt: 0, messages: [] };
    t.messages.push(entry);
    if (t.messages.length > 200) t.messages = t.messages.slice(-200);
    if (!t.title && entry.role === "user") t.title = String(entry.text || "").slice(0, 60);
    t.updatedAt = Date.now();
    transcripts[this.sessionKey] = t;
    const keys = Object.keys(transcripts).sort((a, b) => transcripts[b].updatedAt - transcripts[a].updatedAt);
    for (const k of keys.slice(30)) delete transcripts[k];
    await chrome.storage.local.set({ transcripts });
  }

  // ------------------------------------------------------------- ports (panels)

  async attach(port) {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    port.onMessage.addListener((msg) => this.onPanelMessage(msg).catch(e => {
      this.broadcast({ t: "note", text: "Error: " + e.message });
    }));

    const transcripts = await this.loadTranscripts();
    const t = this.sessionKey && transcripts[this.sessionKey];
    const settings = this.d.getSettings();
    // Determine current model label for display
    let currentModel = "";
    if (settings.backendMode === "direct") {
      currentModel = settings.directModel || "";
    } else if (settings.selectedModel) {
      currentModel = settings.selectedModel;
    }
    port.postMessage({
      t: "state",
      currentModel,
      assistantName: settings.assistantName || "Andrzej",
      debug: settings.debug,
      transcript: t?.messages || [],
      conn: this.d.getConnState(),
      working: this.agent.running,
      approval: this.pendingApproval ? { id: this.pendingApproval.id, ...this.pendingApproval.info } : null,
      prefill: this.pendingPrefill,
    });
    this.pendingPrefill = null;
    this.refreshSite();
    this.pushCatalog(port);
  }

  broadcast(msg) {
    for (const port of this.ports) {
      try { port.postMessage(msg); } catch { /* port died */ }
    }
  }

  async pushCatalog(port = null) {
    try {
      const cat = await this.d.buildCatalog();
      const msg = { t: "catalog", ...cat };
      if (port) port.postMessage(msg); else this.broadcast(msg);
    } catch { /* no catalog — panel will show placeholder */ }
  }

  async refreshSite() {
    if (!this.ports.size) return;
    const info = await this.tools.tabInfo();
    let origin = "";
    try { origin = new URL(info.url || "").origin; } catch { /* chrome:// etc. */ }
    const settings = this.d.getSettings();
    this.broadcast({
      t: "site",
      origin,
      label: origin ? origin.replace(/^https?:\/\//, "") : (info.url || "—").slice(0, 40),
      allowed: !!origin && settings.allowedSites.includes(origin),
      restricted: !!info.restricted,
      tabCount: info.groupTabs?.length || 0,
    });
  }

  // ------------------------------------------------------------- UI adapters

  async addAssistant(text) {
    await this.persist({ role: "assistant", text, at: Date.now() });
    this.broadcast({ t: "assistant", text });
  }

  async addUser(text) {
    await this.persist({ role: "user", text, at: Date.now() });
    this.broadcast({ t: "user", text });
  }

  async systemNote(text, { persist = false } = {}) {
    if (persist) await this.persist({ role: "system", text, at: Date.now() });
    this.broadcast({ t: "note", text });
  }

  addChip(label, why) {
    const id = "c" + (++this.chipSeq);
    this.broadcast({ t: "chip-add", id, label, why: why || "" });
    return {
      setResult: (ok, note, fullError) => {
        this.persist({ role: "chip", text: label + (why ? " — " + why : ""), ok, note, at: Date.now() });
        this.broadcast({ t: "chip-res", id, ok, note: note || (ok ? "ok" : "error"), fullError: fullError || note || "" });
      },
    };
  }

  requestApproval(info) {
    return new Promise((resolve) => {
      const id = "a" + Date.now().toString(36);
      this.pendingApproval = { id, resolve, info };
      this.broadcast({ t: "approval-req", id, ...info });
      this.d.updateBadge();
    });
  }

  resolveApproval(id, answer) {
    if (!this.pendingApproval || this.pendingApproval.id !== id) return;
    const { resolve } = this.pendingApproval;
    this.pendingApproval = null;
    this.broadcast({ t: "approval-done", id, verdict: answer === "no" ? "Rejected" : "OK" });
    this.d.updateBadge();
    resolve(answer);
  }

  hasPendingApproval() { return !!this.pendingApproval; }

  // ------------------------------------------------------------- commands from panel

  async onPanelMessage(msg) {
    this.lastActivityAt = Date.now();
    switch (msg.t) {
      case "send": return this.handleSend(msg.text, { includePage: msg.includePage, includeShot: msg.includeShot });
      case "stop": {
        this.agent.stop();
        if (this.pendingApproval) this.resolveApproval(this.pendingApproval.id, "no");
        this.broadcast({ t: "working", on: false });
        this.broadcast({ t: "note", text: "Stopped." });
        this.d.groups.updateProgressLabel(this.groupId, "");
        this.d.groups.updateStatus(this.groupId, "done", "Stopped");
        return;
      }
      case "approval": return this.resolveApproval(msg.id, msg.answer);
      case "new-chat": return this.newChat();
      case "select-backend": return this.selectBackend(msg.group, msg.model);
      case "history-list": {
        const transcripts = await this.loadTranscripts();
        const items = Object.entries(transcripts)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .map(([key, t]) => ({ key, title: t.title || "(untitled)", updatedAt: t.updatedAt, current: key === this.sessionKey }));
        this.broadcast({ t: "history", items });
        return;
      }
      case "history-pick": {
        this.agent.stop();
        this.d.getBackend()?.resetSession?.(this.sessionKey);
        this.sessionKey = msg.key;
        await this.d.groups.setSessionKey(this.groupId, msg.key);
        this.agent.markPreambleSent(msg.key);
        const transcripts = await this.loadTranscripts();
        this.broadcast({ t: "reset", transcript: transcripts[msg.key]?.messages || [] });
        return;
      }
      case "history-del": {
        const transcripts = await this.loadTranscripts();
        delete transcripts[msg.key];
        await chrome.storage.local.set({ transcripts });
        return this.onPanelMessage({ t: "history-list" });
      }
      case "site-toggle": {
        const info = await this.tools.tabInfo();
        let origin = "";
        try { origin = new URL(info.url || "").origin; } catch { return; }
        if (!origin) return;
        const settings = this.d.getSettings();
        const sites = new Set(settings.allowedSites);
        if (msg.allowed) { sites.add(origin); if (settings.actionMode !== "auto") await chrome.storage.local.set({ actionMode: "auto" }); }
        else sites.delete(origin);
        await chrome.storage.local.set({ allowedSites: [...sites] });
        return;
      }
      case "refresh-site": return this.refreshSite();
      case "refresh-models": return this.pushCatalog();
      case "reconnect": {
        try { await this.d.ensureBackend(); await this.pushCatalog(); }
        catch (e) { /* status went via broadcast; extra note for clarity */ this.systemNote(e.message); }
        return;
      }
      default: return;
    }
  }

  async handleSend(text, { includePage = false, includeShot = false } = {}) {
    text = String(text || "").trim();
    if (!text) return;
    if (this.agent.running || this.d.getBackend()?.isBusy(this.sessionKey)) {
      return this.systemNote(`${this.d.getSettings().assistantName} is still working — stop (■) or wait.`);
    }
    await this.addUser(text);

    // raw OpenClaw commands (e.g. /status, /model, /new) — only in OpenClaw mode
    if (text.startsWith("/") && this.d.getSettings().backendMode === "openclaw") {
      this.broadcast({ t: "working", on: true, label: "Sending command…" });
      try {
        const be = await this.d.ensureBackend();
        const reply = await be.sendAndWaitFinal({
          sessionKey: this.sessionKey, text, timeoutMs: 60000,
          onPartial: (t) => this.broadcast({ t: "partial", text: t }),
        });
        if (reply != null) await this.addAssistant(reply);
        else this.systemNote("No response.");
      } catch (e) {
        this.systemNote("Error: " + e.message);
      } finally {
        this.broadcast({ t: "working", on: false });
      }
      return;
    }

    try {
      await this.d.ensureBackend();
      // Start each turn with a fresh tab-group progress label — the agent will
      // emit {"tool":"progress"} to set a new one as soon as it knows what it's doing.
      await this.d.groups.updateProgressLabel(this.groupId, "");
      await this.agent.run(text, { includePage, includeShot });
      // Reflect HOW the turn ended in the tab-group indicator, so an unfinished
      // task doesn't masquerade as a green "done".
      const reason = this.agent.endReason;
      if (reason === "stopped") {
        // the "stop" handler already set the indicator — leave it.
      } else if (reason === "step-limit" || reason === "no-reply") {
        this.d.groups.updateStatus(this.groupId, "paused", "Incomplete");
      } else {
        this.d.groups.updateStatus(this.groupId, "done", reason === "ask" ? "Waiting for you" : "Task complete");
      }
    } catch (e) {
      this.systemNote("Error: " + e.message);
      this.broadcast({ t: "working", on: false });
      this.d.groups.updateStatus(this.groupId, "error", e.message.slice(0, 40));
    }
  }

  async newChat() {
    this.agent.stop();
    this.d.getBackend()?.resetSession?.(this.sessionKey);
    this.sessionKey = makeSessionKey();
    await this.d.groups.setSessionKey(this.groupId, this.sessionKey);
    await this.d.groups.updateProgressLabel(this.groupId, "");
    await this.d.groups.updateStatus(this.groupId, "idle", "");
    this.broadcast({ t: "reset", transcript: [] });
  }

  /** Backend/model selection from the panel: "openclaw" or "direct:<providerId>". */
  async selectBackend(group, model) {
    if (this.agent.running || this.d.getBackend()?.isBusy(this.sessionKey)) {
      return this.systemNote("Wait for the current response to finish, then change the model again.");
    }
    if (group === "openclaw") {
      await this.d.applySelection({ mode: "openclaw", model });
      if (model) {
        this.broadcast({ t: "working", on: true, label: "Switching model…" });
        try {
          const be = await this.d.ensureBackend();
          const reply = await be.sendAndWaitFinal({
            sessionKey: this.sessionKey, text: `/model ${model}`, timeoutMs: 30000, onPartial: () => {},
          });
          if (reply) await this.addAssistant(reply);
        } catch (e) { this.systemNote("Couldn't change model: " + e.message); }
        finally { this.broadcast({ t: "working", on: false }); }
      }
    } else if (group.startsWith("direct:")) {
      const pid = group.slice("direct:".length);
      const s = this.d.getSettings();
      const chosen = model || s.providerModels?.[pid] || "";
      await this.d.applySelection({ mode: "direct", provider: pid, model: chosen });
      const label = getPreset(pid)?.label || pid;
      this.systemNote(`Model: ${label}${chosen ? " — " + chosen : ""}`);
    }
    this.pushCatalog();
  }

  /** Command from context menu (background). */
  async queuePrompt({ mode, text, includePage }) {
    if (mode === "send") {
      return this.handleSend(text, { includePage: !!includePage, includeShot: false });
    }
    if (this.ports.size) this.broadcast({ t: "prefill", text });
    else this.pendingPrefill = text;
  }

  /** Proactive agent message in this session (e.g. heartbeat/cron). */
  async onUnsolicited(text) {
    await this.addAssistant(text);
  }

  /** OpenClaw server tool activity ("agent" events). */
  onServerActivity(detail) {
    this.broadcast({ t: "srv-act", ...detail });
  }

  isBusy() {
    return this.agent.running || !!this.d.getBackend()?.isBusy(this.sessionKey) || !!this.pendingApproval;
  }

  async dispose() {
    this.agent.stop();
    if (this.pendingApproval) this.resolveApproval(this.pendingApproval.id, "no");
    for (const port of this.ports) { try { port.disconnect(); } catch { /* ignore */ } }
    this.ports.clear();
  }
}

function makeSessionKey() {
  const rand = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
  return `chrome-ext:${rand}`;
}
