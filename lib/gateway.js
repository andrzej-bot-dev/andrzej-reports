// OpenClaw gateway WebSocket client — protocol v4, multiple parallel sessions.
//
// Connection (shared across all tab groups):
//   1. WS open → gateway sends "connect.challenge" event with nonce
//   2. client sends "connect" request: protocol 4, role operator, auth.token
//      + Ed25519 device identity (nonce signature, payload v3)
//   3. "hello-ok" (or PAIRING_REQUIRED → `openclaw devices approve --latest`)
//
// Chat (per session = per tab group):
//   chat.send {sessionKey, message, idempotencyKey} → ack {runId=idempotencyKey}
//   stream: "chat" events {runId, state: delta|final|error|aborted, deltaText,
//   message}; turn ends for a given runId when state is terminal.
//   "agent" events (stream tool/item) → server tool activity.

import { loadOrCreateDeviceIdentity, buildDeviceAuthPayloadV3, signDevicePayload } from "./device.js";
import { normalizeUrl, shortUrl, stripDataUrl, extractText, makeGatewayError, classifyConnectError, closeReason, redactFrame } from "./gateway-helpers.js";

const PROTOCOL_VERSION = 4;
const EXT_VERSION = "0.1.0";

export class OpenClawGateway extends EventTarget {
  constructor({ url, urls, token, displayName, debug }) {
    super();
    // list of addresses tried in order (e.g. LAN at home, wss via tunnel when traveling)
    this.urls = [...new Set((urls?.length ? urls : [url]).filter(Boolean).map(normalizeUrl))];
    this.activeUrl = this.urls[0] || "";
    this.token = (token || "").trim();
    this.displayName = displayName || "Chrome (OpenClaw extension)";
    this.debug = debug || (() => {});
    this.ws = null;
    this.connected = false;
    this.hello = null;
    this.supportsAttachments = true;
    this.reqId = 0;
    this.pending = new Map();       // request id -> {resolve, reject, timer}
    this.runs = new Map();          // runId -> {sessionKey, resolve, reject, timer, buffer, onPartial}
    this.busySessions = new Set();  // sessionKey with an active turn
    this.canonical = new Map();     // sessionKey -> server canonical key (agent:<id>:...)
    this._closedByUs = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._watchdog = null;
    this._lastFrameAt = 0;
    this._challengeNonce = null;
    this._challengeWaiters = [];
  }

  makeSessionKey() {
    const rand = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
    return `chrome-ext:${rand}`;
  }

  /** Whether an event with key `key` belongs to our (short) session `short`. */
  sessionMatches(short, key) {
    if (!short || !key) return false;
    return key === short || key === this.canonical.get(short) || key.endsWith(":" + short);
  }

  // ------------------------------------------------------------- connection

  async connect({ timeoutMs = 12000 } = {}) {
    this._closedByUs = false;
    clearTimeout(this._reconnectTimer);
    this._emitStatus("connecting");

    let lastErr = null;
    for (const url of this.urls) {
      if (this._closedByUs) throw new Error("Connection cancelled.");
      this.activeUrl = url;

      try {
        await this._openSocket(url, timeoutMs);
        var nonce = await this._waitForChallenge(Math.min(timeoutMs, 12000));
      } catch (e) {
        lastErr = new Error(`${shortUrl(url)}: ${e.message}`);
        this.debug("×", `(${shortUrl(url)} unreachable: ${e.message})`);
        try { this.ws?.close(); } catch { /* ignore */ }
        continue;
      }

      const params = await this._buildConnectParams(nonce);
      try {
        const hello = await this._request("connect", params, { timeoutMs: 12000 });
        this.connected = true;
        this.hello = hello;
        this._reconnectDelay = 1000;
        const deviceToken = hello?.auth?.deviceToken;
        if (deviceToken) chrome.storage.local.set({ gatewayDeviceToken: deviceToken }).catch(() => {});
        this._startWatchdog(hello?.policy?.tickIntervalMs || 30000);
        this._emitStatus("online", shortUrl(url));
        return {
          raw: hello,
          url,
          serverInfo: `openclaw ${hello?.server?.version || ""}`.trim(),
          protocol: hello?.protocol,
          scopes: hello?.auth?.scopes || [],
        };
      } catch (e) {
        const friendly = classifyConnectError(e);
        this._emitStatus(friendly.state, friendly.message);
        try { this.ws?.close(); } catch { /* already closed */ }
        if (friendly.state === "pairing" && !this._closedByUs) {
          this._reconnectDelay = 5000;
          this._scheduleReconnect();
        }
        throw new Error(friendly.message);
      }
    }

    const msg = this.urls.length > 1
      ? `No address responds. Last error — ${lastErr?.message || "?"}`
      : (lastErr?.message || "Failed to connect.");
    this._emitStatus("offline", msg);
    if (!this._closedByUs) this._scheduleReconnect();
    throw new Error(msg);
  }

  _openSocket(url, timeoutMs) {
    this._challengeNonce = null;
    this._challengeWaiters = [];
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return reject(new Error(`invalid WebSocket address (${e.message})`));
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error("connection timed out — gateway not listening or port blocked"));
        }
      }, timeoutMs);

      ws.onopen = () => {
        this.debug("→", "(open) " + url);
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      };
      ws.onmessage = (ev) => this._onFrame(ev.data);
      ws.onerror = () => this.debug("×", "(ws error)");
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const was = this.connected;
        this.connected = false;
        this._stopWatchdog();
        this.debug("×", `(close code=${ev.code} reason=${ev.reason || "-"})`);
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(ev.reason || "Connection closed.")); }
        this.pending.clear();
        for (const [, run] of this.runs) {
          clearTimeout(run.timer);
          run.resolve(run.buffer || null);
        }
        this.runs.clear();
        this.busySessions.clear();
        if (!settled) { settled = true; reject(new Error(closeReason(ev))); }
        if (was) {
          this._emitStatus("offline", ev.reason || "connection lost");
          if (!this._closedByUs) this._scheduleReconnect();
        }
      };
    });
  }

  _waitForChallenge(timeoutMs) {
    if (this._challengeNonce) {
      const n = this._challengeNonce;
      this._challengeNonce = null;
      return Promise.resolve(n);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway didn't send connect.challenge — is this really OpenClaw?")), timeoutMs);
      this._challengeWaiters.push((nonce) => { clearTimeout(timer); resolve(nonce); });
    });
  }

  async _buildConnectParams(nonce) {
    const identity = await loadOrCreateDeviceIdentity();
    const { gatewayDeviceToken } = await chrome.storage.local.get("gatewayDeviceToken");
    const authToken = this.token || gatewayDeviceToken || "";
    const scopes = ["operator.read", "operator.write"];
    const clientId = "gateway-client";
    const clientMode = "backend";
    const role = "operator";
    const platform = "chrome";
    const deviceFamily = "chrome-extension";
    const signedAtMs = Date.now();

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId, clientMode, role, scopes, signedAtMs,
      token: authToken || null, nonce, platform, deviceFamily,
    });
    const signature = await signDevicePayload(identity.privateKey, payload);

    let { instanceId } = await chrome.storage.local.get("instanceId");
    if (!instanceId) {
      instanceId = crypto.randomUUID?.() || String(Math.random()).slice(2);
      chrome.storage.local.set({ instanceId }).catch(() => {});
    }

    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: clientId,
        displayName: this.displayName,
        version: EXT_VERSION,
        platform,
        deviceFamily,
        mode: clientMode,
        instanceId,
      },
      role,
      scopes,
      caps: ["tool-events"],
      auth: authToken ? { token: authToken } : undefined,
      locale: (globalThis.navigator?.language || "en-US"),
      userAgent: `openclaw-chrome-ext/${EXT_VERSION}`,
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKeyB64u,
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => { /* next retry will schedule itself */ });
    }, delay);
  }

  close() {
    this._closedByUs = true;
    clearTimeout(this._reconnectTimer);
    this._stopWatchdog();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }

  _emitStatus(state, reason = "") {
    this.dispatchEvent(new CustomEvent("status", { detail: { state, reason } }));
  }

  _startWatchdog(tickIntervalMs) {
    this._stopWatchdog();
    this._lastFrameAt = Date.now();
    const limit = Math.max(tickIntervalMs * 2, 20000);
    this._watchdog = setInterval(() => {
      if (Date.now() - this._lastFrameAt > limit) {
        this.debug("×", `(watchdog: silence > ${limit}ms — closing)`);
        try { this.ws?.close(4000, "tick timeout"); } catch { /* ignore */ }
      }
    }, Math.min(tickIntervalMs, 15000));
  }
  _stopWatchdog() { clearInterval(this._watchdog); this._watchdog = null; }

  /** Lightweight RPC keeping the service worker and connection alive. */
  async ping() {
    if (!this.connected) return false;
    try { await this._request("health", {}, { timeoutMs: 10000 }); return true; }
    catch { return false; }
  }

  // ------------------------------------------------------------- frames

  _request(method, params, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("No gateway connection."));
      }
      const id = "req-" + (++this.reqId);
      const frame = { type: "req", id, method, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout on method ${method} (${timeoutMs}ms).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.debug("→", redactFrame(frame));
      this.ws.send(JSON.stringify(frame));
    });
  }

  _onFrame(raw) {
    this._lastFrameAt = Date.now();
    let frame;
    try { frame = JSON.parse(raw); } catch { this.debug("←", "(non-JSON) " + String(raw).slice(0, 200)); return; }
    if (frame.event !== "tick") this.debug("←", frame);

    if (frame.type === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload ?? {});
      else p.reject(makeGatewayError(frame.error));
      return;
    }

    if (frame.type === "event") this._onEvent(frame.event, frame.payload ?? {});
  }

  _onEvent(event, payload) {
    if (event === "connect.challenge") {
      const nonce = payload?.nonce;
      if (this._challengeWaiters.length) this._challengeWaiters.shift()(nonce);
      else this._challengeNonce = nonce;
      return;
    }
    if (event === "chat") return this._onChatEvent(payload);
    if (event === "agent") return this._onAgentEvent(payload);
    if (event === "tick" || event === "presence" || event === "health" || event === "heartbeat") return;
    this.dispatchEvent(new CustomEvent("gateway-event", { detail: { event, payload } }));
  }

  _onChatEvent(p) {
    const run = p.runId ? this.runs.get(p.runId) : null;
    if (run && p.sessionKey) this.canonical.set(run.sessionKey, p.sessionKey);

    const snapshotText = extractText(p.message);

    if (p.state === "delta") {
      if (!run) return;
      if (typeof snapshotText === "string" && snapshotText) run.buffer = snapshotText;
      else if (p.replace) run.buffer = p.deltaText || "";
      else run.buffer += p.deltaText || "";
      run.onPartial?.(run.buffer);
      return;
    }

    if (p.state === "final" || p.state === "error" || p.state === "aborted") {
      const text = snapshotText ?? run?.buffer ?? "";
      if (run) {
        this._finishRun(p.runId);
        if (p.state === "final") run.resolve(text || run.buffer || "");
        else if (p.state === "aborted") run.resolve(null);
        else run.reject(new Error(p.errorMessage || "Agent reported an error."));
      } else if (p.state === "final" && text) {
        this.dispatchEvent(new CustomEvent("assistant-unsolicited", {
          detail: { text, sessionKey: p.sessionKey || "" }
        }));
      }
    }
  }

  _onAgentEvent(p) {
    const d = p.data || {};
    if ((p.stream === "item" || p.stream === "tool") && d.title) {
      const run = p.runId ? this.runs.get(p.runId) : null;
      this.dispatchEvent(new CustomEvent("agent-activity", {
        detail: {
          sessionKey: run?.sessionKey || p.sessionKey || "",
          itemId: d.itemId || `${p.runId}-${p.seq}`,
          phase: d.phase || "start",
          title: d.title,
          kind: d.kind || "tool",
          status: d.status || "running",
        }
      }));
    }
  }

  _finishRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    this.busySessions.delete(run.sessionKey);
    clearTimeout(run.timer);
  }

  // ------------------------------------------------------------- chat

  isBusy(sessionKey) { return this.busySessions.has(sessionKey); }

  async sendAndWaitFinal({ sessionKey, text, attachments = [], timeoutMs = 300000, onPartial, systemMessage }) {
    if (!this.connected) throw new Error("No gateway connection.");
    if (!sessionKey) throw new Error("Missing sessionKey.");
    if (this.busySessions.has(sessionKey)) throw new Error("This conversation is still replying — wait or stop it.");

    // The gateway protocol has no separate system-prompt channel — deliver the
    // agent preamble by prepending it to the message. The agent loop only sets
    // systemMessage on the FIRST call of a session in gateway mode (the server
    // is stateful), so this doesn't repeat on every step.
    const message = systemMessage ? `${systemMessage}\n\n${text ?? ""}` : (text ?? "");

    const idempotencyKey = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const params = { sessionKey, message, idempotencyKey };
    if (attachments.length) {
      params.attachments = attachments.map(a => ({
        type: "image",
        mimeType: a.mimeType || "image/jpeg",
        fileName: a.name || "image.jpg",
        content: stripDataUrl(a.dataUrl),
      }));
    }

    const finalPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const run = this.runs.get(idempotencyKey);
        if (run) { this._finishRun(idempotencyKey); resolve(run.buffer || null); }
      }, timeoutMs);
      this.runs.set(idempotencyKey, { sessionKey, resolve, reject, timer, buffer: "", onPartial });
      this.busySessions.add(sessionKey);
    });

    try {
      await this._request("chat.send", params, { timeoutMs: 30000 });
    } catch (e) {
      this._finishRun(idempotencyKey);
      if (attachments.length && /attachment|image|payload|base64/i.test(e.message)) {
        this.supportsAttachments = false;
        return this.sendAndWaitFinal({
          sessionKey,
          text: (text ?? "") + "\n(Note: screenshot could not be attached: " + e.message + ")",
          attachments: [], timeoutMs, onPartial,
          systemMessage, // first-of-session preamble must survive the retry
        });
      }
      throw e;
    }
    return finalPromise;
  }

  cancelRun(sessionKey) {
    const entry = [...this.runs.entries()].find(([, r]) => r.sessionKey === sessionKey);
    if (!entry) return;
    const [runId, run] = entry;
    this._finishRun(runId);
    if (this.connected) {
      this._request("chat.abort", { sessionKey: this.canonical.get(sessionKey) || sessionKey, runId }, { timeoutMs: 8000 })
        .catch(() => { /* we end locally anyway */ });
    }
    run.resolve(null);
  }

  // ------------------------------------------------------------- models / sessions

  async listModels() {
    let res = await this._request("models.list", { view: "configured" }, { timeoutMs: 15000 });
    if (!res?.models?.length) {
      res = await this._request("models.list", { view: "all" }, { timeoutMs: 15000 });
    }
    const models = res?.models || [];
    return models.map(m => ({ id: m.id, name: m.name || m.id, alias: m.alias, available: m.available !== false }));
  }

  async fetchHistory(sessionKey, { limit = 10 } = {}) {
    const res = await this._request("chat.history", {
      sessionKey: this.canonical.get(sessionKey) || sessionKey, limit,
    }, { timeoutMs: 15000 });
    return res?.messages || [];
  }
}
