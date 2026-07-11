// Service worker (module) — the extension's brain.
//
// Two modes (backends), switchable from the panel:
//   • "openclaw" — WebSocket to the OpenClaw gateway on Raspberry Pi (Andrzej persona)
//   • "direct"   — directly to any LLM API (OpenAI/Anthropic-compatible),
//                  like the Jan app; just need an API key in settings.
// Both backends expose the same interface, so the controller and agent loop are shared.
//
// Session = tab group (like Claude in Chrome). The connection and agent loops live here,
// so work continues when the panel is hidden.

import { loadSettings, DEFAULTS } from "./lib/settings.js";
import { OpenClawGateway } from "./lib/gateway.js";
import { DirectBackend } from "./lib/direct.js";
import { PROVIDER_PRESETS, getPreset } from "./lib/providers.js";
import { GroupManager } from "./lib/groups.js";
import { ChatController } from "./lib/controller.js";

let settings = { ...DEFAULTS };
let settingsReady = loadSettings().then((s) => { settings = s; });
const getSettings = () => settings;

let gateway = null;
let direct = null;
let connState = { state: "offline", reason: "" };
let keepaliveTimer = null;
let connectPromise = null;
const controllers = new Map(); // groupId -> ChatController

// ---------------------------------------------------------------- groups

const groups = new GroupManager({
  assistantName: DEFAULTS.assistantName,
  onGroupRemoved: (groupId) => {
    const ctl = controllers.get(groupId);
    if (ctl) { ctl.dispose(); controllers.delete(groupId); }
    controllerInit.delete(groupId);
    maybeIdleDisconnect();
  },
  onGroupTabsChanged: (groupId) => {
    if (groupId && controllers.has(groupId)) controllers.get(groupId).refreshSite();
    else controllers.forEach((c) => c.refreshSite());
  },
});
groups.wireEvents();

const controllerInit = new Map(); // groupId -> Promise<ChatController> being created (deduplication for race)
function ensureController(groupId) {
  const existing = controllers.get(groupId);
  if (existing) return Promise.resolve(existing);
  if (controllerInit.has(groupId)) return controllerInit.get(groupId);
  const p = (async () => {
    const ctl = new ChatController({
      groupId, groups, getSettings,
      ensureBackend, getBackend,
      getConnState: () => connState,
      updateBadge, buildCatalog, applySelection,
    });
    await ctl.init();
    controllers.set(groupId, ctl);
    controllerInit.delete(groupId);
    return ctl;
  })();
  controllerInit.set(groupId, p);
  return p;
}

function updateBadge() {
  const pending = [...controllers.values()].some((c) => c.hasPendingApproval());
  chrome.action.setBadgeText({ text: pending ? "!" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#e0b13f" }).catch(() => {});
}

function broadcastAll(msg) { controllers.forEach((c) => c.broadcast(msg)); }

// ---------------------------------------------------------------- backend

function getBackend() {
  return settings.backendMode === "direct" ? direct : gateway;
}

function buildDirect() {
  const gw = new DirectBackend({
    getSettings,
    debug: (dir, frame) => {
      if (!settings.debug) return;
      broadcastAll({ t: "debug", line: `${dir} ${typeof frame === "string" ? frame : JSON.stringify(frame)}`.slice(0, 1500) });
    },
  });
  gw.addEventListener("status", (e) => {
    if (settings.backendMode !== "direct") return;
    connState = e.detail;
    broadcastAll({ t: "conn", ...connState });
  });
  return gw;
}

function buildGateway() {
  const gw = new OpenClawGateway({
    urls: [settings.gatewayUrl, settings.gatewayUrlRemote].filter(Boolean),
    token: settings.gatewayToken,
    displayName: `Chrome — ${settings.assistantName}`,
    debug: (dir, frame) => {
      if (!settings.debug) return;
      broadcastAll({ t: "debug", line: `${dir} ${typeof frame === "string" ? frame : JSON.stringify(frame)}`.slice(0, 1500) });
    },
  });
  gw.addEventListener("status", (e) => {
    if (settings.backendMode !== "openclaw") return;
    connState = e.detail;
    broadcastAll({ t: "conn", ...connState });
    if (e.detail.state === "online") startKeepalive(); else stopKeepalive();
  });
  gw.addEventListener("assistant-unsolicited", (e) => {
    const { text, sessionKey } = e.detail;
    for (const ctl of controllers.values())
      if (gw.sessionMatches(ctl.sessionKey, sessionKey)) { ctl.onUnsolicited(text); return; }
  });
  gw.addEventListener("agent-activity", (e) => {
    const d = e.detail;
    for (const ctl of controllers.values())
      if (gw.sessionMatches(ctl.sessionKey, d.sessionKey) || ctl.sessionKey === d.sessionKey) { ctl.onServerActivity(d); return; }
  });
  return gw;
}

/** Ensures a ready active backend (connects gateway or validates direct key). */
async function ensureBackend() {
  await settingsReady;

  if (settings.backendMode === "direct") {
    stopKeepalive();
    if (gateway?.connected) gateway.close();
    if (!direct) direct = buildDirect();
    direct.setSelection(settings.directProvider, settings.directModel);
    const ok = direct.ready();
    const label = getPreset(settings.directProvider)?.label || "model";
    connState = ok ? { state: "online", reason: label } : { state: "offline", reason: "Add a provider API key in settings." };
    broadcastAll({ t: "conn", ...connState });
    if (!ok) throw new Error(connState.reason);
    return direct;
  }

  // openclaw
  direct?.close();
  if (gateway?.connected) return gateway;
  if (connectPromise) { await connectPromise.catch(() => {}); if (gateway?.connected) return gateway; }
  if (!settings.gatewayUrl && !settings.gatewayUrlRemote) {
    connState = { state: "offline", reason: "Set the OpenClaw gateway address or switch to a model with an API key." };
    broadcastAll({ t: "conn", ...connState });
    throw new Error(connState.reason);
  }
  if (!gateway) gateway = buildGateway();
  connectPromise = gateway.connect().finally(() => { connectPromise = null; });
  await connectPromise;
  return gateway;
}

/** Switch backend/model from the panel — immediately in memory + persistently. */
async function applySelection(sel) {
  const patch = {};
  if (sel.mode) patch.backendMode = sel.mode;
  if (sel.mode === "openclaw") patch.selectedModel = sel.model || "";
  if (sel.mode === "direct") { patch.directProvider = sel.provider || ""; patch.directModel = sel.model || ""; }
  Object.assign(settings, patch);
  await chrome.storage.local.set(patch);
  try { await ensureBackend(); } catch { /* status went via broadcast */ }
}

/** Model catalog for the panel: OpenClaw group + a group per provider with a key. */
async function buildCatalog() {
  await settingsReady;
  const s = settings;

  // Ensure direct backend is initialized so listModels() works
  if (s.backendMode === "direct" && !direct) {
    try { direct = buildDirect(); direct.setSelection(s.directProvider, s.directModel); } catch { /* no key */ }
  }

  const groupsOut = [];

  if (s.gatewayUrl || s.gatewayUrlRemote) {
    let models = [];
    if (s.backendMode === "openclaw" && gateway?.connected) { try { models = await gateway.listModels(); } catch { /* offline */ } }
    groupsOut.push({ key: "openclaw", label: "OpenClaw 🦞", models: models.map((m) => ({ id: m.id, label: m.alias || m.name || m.id })) });
  }
  for (const p of PROVIDER_PRESETS) {
    if (!s.providerKeys?.[p.id]) continue;
    let models = [];
    if (s.backendMode === "direct" && s.directProvider === p.id && direct) {
      try { const live = await direct.listModels(); if (live.length) models = live.map((m) => ({ id: m.id, label: m.name || m.id })); } catch { /* empty */ }
    }
    // Also try to fetch models even if direct backend isn't active yet
    if (!models.length) {
      try {
        const tmp = new DirectBackend({ getSettings: () => s });
        tmp.setSelection(p.id, "");
        const live = await tmp.listModels();
        if (live.length) models = live.map((m) => ({ id: m.id, label: m.name || m.id }));
      } catch { /* empty */ }
    }
    groupsOut.push({ key: `direct:${p.id}`, label: p.label, models });
  }

  let active = s.backendMode === "openclaw"
    ? { group: "openclaw", model: s.selectedModel || "" }
    : { group: `direct:${s.directProvider}`, model: s.directModel || s.providerModels?.[s.directProvider] || "" };

  // Auto-select last used model if none chosen, or first available model
  if (!active.model) {
    for (const g of groupsOut) {
      if (g.models.length) {
        // Try to find a previously used model from providerModels
        const saved = s.providerModels?.[g.key.replace(/^direct:/, "")];
        const match = saved ? g.models.find(m => m.id === saved) : null;
        active = { group: g.key, model: (match || g.models[0]).id };
        break;
      }
    }
    // If we auto-selected, persist it
    if (active.model) {
      if (active.group.startsWith("direct:")) {
        const pid = active.group.slice("direct:".length);
        chrome.storage.local.set({ directProvider: pid, directModel: active.model, backendMode: "direct" });
      } else {
        chrome.storage.local.set({ selectedModel: active.model, backendMode: "openclaw" });
      }
    }
  }

  return { groups: groupsOut, active };
}

// ---------------------------------------------------------------- keepalive (openclaw)

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => { if (settings.backendMode === "openclaw") gateway?.ping(); }, 25000);
}
function stopKeepalive() { clearInterval(keepaliveTimer); keepaliveTimer = null; }

function maybeIdleDisconnect() {
  if (!gateway) return;
  const anyPorts = [...controllers.values()].some((c) => c.ports.size > 0);
  const anyBusy = [...controllers.values()].some((c) => c.isBusy());
  const idleMs = Date.now() - Math.max(0, ...[...controllers.values()].map((c) => c.lastActivityAt));
  if (!anyPorts && !anyBusy && idleMs > 3 * 60 * 1000) {
    gateway.close(); gateway = null; stopKeepalive();
    if (settings.backendMode === "openclaw") connState = { state: "offline", reason: "idle (inactivity)" };
  }
}

chrome.alarms.create("oc-tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "oc-tick") return;
  const anyBusy = [...controllers.values()].some((c) => c.isBusy());
  const anyPorts = [...controllers.values()].some((c) => c.ports.size > 0);
  if (settings.backendMode === "openclaw") {
    if ((anyBusy || anyPorts) && (!gateway || !gateway.connected)) ensureBackend().catch(() => {});
    else if (gateway?.connected) { gateway.ping(); maybeIdleDisconnect(); }
  }
  // Push catalog to all panels with open ports — ensures models appear
  // even if they weren't ready on first connect
  if (anyPorts && !anyBusy) {
    for (const ctl of controllers.values()) if (ctl.ports.size) ctl.pushCatalog();
  }
});

// ---------------------------------------------------------------- start / install

chrome.runtime.onInstalled.addListener(() => {
  // Disable openPanelOnActionClick — we handle panel opening manually in
  // action.onClicked so we can also do tab grouping synchronously.
  // With openPanelOnActionClick=true, onClicked does NOT fire, so tab grouping
  // only happens via panel→SW message roundtrip, causing the "two clicks" bug.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  groups.rebuild();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ask-selection", title: "Ask Andrzej about selection", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "translate-selection", title: "Translate selection", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "summarize-page", title: "Summarize this page", contexts: ["page"] });
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  groups.rebuild();
});

// live settings (changes from options: keys, gateway addresses, etc.)
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const keys = ["gatewayUrl", "gatewayUrlRemote", "gatewayToken", "assistantName",
    "actionMode", "maxSteps", "allowScreenshots", "debug", "allowedSites",
    "providerKeys", "providerModels", "providerBaseUrls", "directMaxTokens"];
  if (!keys.some((k) => k in changes)) return;
  settings = await loadSettings();
  groups.assistantName = settings.assistantName;

  if (changes.gatewayUrl || changes.gatewayUrlRemote || changes.gatewayToken) {
    gateway?.close(); gateway = null;
    if (settings.backendMode === "openclaw") {
      connState = { state: "offline", reason: "connection settings changed" };
      broadcastAll({ t: "conn", ...connState });
      if ([...controllers.values()].some((c) => c.ports.size > 0)) ensureBackend().catch(() => {});
    }
  }
  if (changes.providerKeys && settings.backendMode === "direct") ensureBackend().catch(() => {});
  if (changes.allowedSites || changes.assistantName) controllers.forEach((c) => c.refreshSite());
  controllers.forEach((c) => c.pushCatalog());
});

// ---------------------------------------------------------------- panel opening
//
// FIX: chrome.sidePanel.open() must be called synchronously within a user gesture.
// Any await/then BEFORE open() (even setOptions().then()) can break the gesture
// context in MV3 service workers. We call setOptions() and open() back-to-back
// synchronously — both API calls are synchronous (the returned promises are just
// for error handling). Heavy work (tab grouping, controller creation, backend
// connection) happens AFTER open(), in bindTab(). The panel, opened by a fresh
// click, doesn't know its group yet (URL ?tab=…) and asks the SW via a
// "bind-tab" message — see sidepanel/panel.js.

/** Opens the panel synchronously within a gesture — no awaits or .then() before open(). */
function openPanelForGesture(tab) {
  if (!tab?.id) return;
  // Always use tabId-based path so the panel is scoped to this tab.
  // The panel will resolve its group via bind-tab message.
  const path = "sidepanel/panel.html";
  // Synchronous calls — both fire within the user gesture stack frame
  chrome.sidePanel.setOptions({ tabId: tab.id, path, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
    // Fallback: try window-level open if tab-level fails
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });
}

/** Heavy part: group + controller + backend. No open() (already opened by gesture). */
async function bindTab(tab) {
  if (!tab?.id) return;
  const groupId = await groups.ensureGroupForTab(tab);
  const ctl = await ensureController(groupId);
  await ensureBackend().catch(() => {});
  // Now that backend is ready, push the model catalog to all panels
  ctl?.pushCatalog();
  return groupId;
}

// action.onClicked fires because openPanelOnActionClick is false.
// We call open() synchronously in the gesture, then do tab grouping.
// This ensures both panel AND group are created in one click.
chrome.action.onClicked.addListener((tab) => {
  openPanelForGesture(tab);
  bindTab(tab);
});

// Keyboard shortcut: commands.onCommand provides a user-gesture context,
// so chrome.sidePanel.open() works here.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "open-panel" || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  bindTab(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const sel = (info.selectionText || "").slice(0, 4000);
  let prompt = null;
  if (info.menuItemId === "ask-selection") prompt = { mode: "prefill", text: `Excerpt from the page:\n"${sel}"\n\n` };
  else if (info.menuItemId === "translate-selection") prompt = { mode: "send", text: `Translate to English:\n"${sel}"` };
  else if (info.menuItemId === "summarize-page") prompt = { mode: "send", text: "Summarize this page.", includePage: true };
  if (!prompt) return;
  openPanelForGesture(tab);
  bindTab(tab).then((groupId) => {
    if (groupId == null) return;
    return ensureController(groupId).then((ctl) => ctl.queuePrompt(prompt));
  }).catch(() => {});
});

// Panel asks SW for its group when opened by a fresh click (URL ?tab=…, no ?group=).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.t !== "bind-tab") return;
  (async () => {
    try {
      const tabId = msg.tabId ?? sender.tab?.id;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!tab) return sendResponse({ error: "no-tab" });
      const groupId = await bindTab(tab);
      sendResponse({ groupId });
    } catch (e) { sendResponse({ error: e.message }); }
  })();
  return true; // async response
});

// ---------------------------------------------------------------- panel ports

// Intercept tabs opened by target=_blank clicks within a group — Chrome
// activates them by default, stealing focus from the user's current app.
// Deactivate them immediately and let the agent pick them up via getTargetTab().
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.groupId || tab.groupId === -1) return;
  if (tab.active) {
    chrome.tabs.update(tab.id, { active: false }).catch(() => {});
  }
});

chrome.runtime.onConnect.addListener(async (port) => {
  const m = /^panel-(\d+)$/.exec(port.name || "");
  if (!m) return;
  const groupId = Number(m[1]);
  const ctl = await ensureController(groupId);
  await ctl.attach(port);
  ensureBackend().catch(() => {});
  port.onDisconnect.addListener(() => setTimeout(maybeIdleDisconnect, 1000));
});
