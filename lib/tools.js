// Browser tool executor — runs in the service worker,
// ALWAYS within a single tab group (session = group, like Claude in Chrome).
// The action target is the group's active tab; when the user is browsing outside
// the group, the agent keeps working on the group's last active tab.

const CONTENT_CMDS = new Set([
  "snapshot", "get_text", "page_info", "click", "fill", "press",
  "select_option", "scroll", "find", "wait_for", "highlight", "working_indicator"
]);

const RESTRICTED_URL = /^(chrome|chrome-extension|edge|devtools|about|view-source|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com):?/i;

export class BrowserTools {
  /**
   * @param {object} opts
   *  groupId            – tab group within which actions are allowed
   *  getLastActiveTabId – () => id of the group's last active tab (may be null)
   */
  constructor({ groupId, getLastActiveTabId }) {
    this.groupId = groupId;
    this.getLastActiveTabId = getLastActiveTabId || (() => null);
  }

  /** The tab we operate on: the group's active tab, last active tab, or most recently added tab. */
  async getTargetTab() {
    const tabs = await chrome.tabs.query({ groupId: this.groupId });
    if (!tabs.length) return null;
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused && focused.groupId === this.groupId) return focused;
    const last = tabs.find(t => t.id === this.getLastActiveTabId());
    if (last) return last;
    // Prefer the most recently created tab in the group (handles target=_blank clicks)
    return tabs.reduce((newest, t) => (t.id > newest.id ? t : newest), tabs[0]);
  }

  async requireTab() {
    const tab = await this.getTargetTab();
    if (!tab) throw new Error("No tabs left in the group.");
    if (RESTRICTED_URL.test(tab.url || "")) {
      throw new Error(`Can't operate on this page (${tab.url}). Switch to a regular web page in the group.`);
    }
    return tab;
  }

  async sendToContent(cmd, args = {}) {
    const tab = await this.requireTab();
    const msg = { __ocx: true, cmd, args };
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
        await new Promise(r => setTimeout(r, 150));
        return await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e2) {
        throw new Error(`Can't connect to the page (${e2.message}). Refresh the tab and try again.`);
      }
    }
  }

  // ---------- tab-level tools ----------

  async navigate({ url }) {
    if (!url) throw new Error("Missing URL.");
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const tab = await this.requireTab();
    await chrome.tabs.update(tab.id, { url });
    await this.waitForTabLoad(tab.id, 20000);
    const t = await chrome.tabs.get(tab.id);
    return { ok: true, url: t.url, title: t.title };
  }

  async goBack() {
    const tab = await this.requireTab();
    await chrome.tabs.goBack(tab.id).catch(() => { throw new Error("Can't go back."); });
    await this.waitForTabLoad(tab.id, 15000);
    const t = await chrome.tabs.get(tab.id);
    return { ok: true, url: t.url, title: t.title };
  }

  /** A new tab goes into THIS SAME group (expands the session, like Claude). */
  async newTab({ url }) {
    const current = await this.getTargetTab();
    const t = await chrome.tabs.create({
      url: url ? (/^https?:\/\//i.test(url) ? url : "https://" + url) : "about:blank",
      active: false,
      windowId: current?.windowId,
    });
    await chrome.tabs.group({ tabIds: [t.id], groupId: this.groupId });
    if (url) await this.waitForTabLoad(t.id, 20000);
    // Don't force-activate the tab — this steals window focus from other apps
    // (Discord, etc). The tab loads in the background and the agent can
    // interact with it via content script without needing it to be visible.
    const fresh = await chrome.tabs.get(t.id);
    return { ok: true, url: fresh.url, title: fresh.title };
  }

  async tabInfo() {
    const tab = await this.getTargetTab();
    if (!tab) return { ok: false, error: "No tabs in the group." };
    const all = await chrome.tabs.query({ groupId: this.groupId });
    return {
      ok: true, url: tab.url, title: tab.title, tabId: tab.id,
      restricted: RESTRICTED_URL.test(tab.url || ""),
      groupTabs: all.map(t => ({ tabId: t.id, url: t.url, title: t.title, current: t.id === tab.id })),
    };
  }

  /** Switch the active tab within the group (agent can manipulate any tab in its group). */
  async switchTab({ url, tabId }) {
    const tabs = await chrome.tabs.query({ groupId: this.groupId });
    let target = null;
    if (tabId) target = tabs.find(t => t.id === tabId);
    if (!target && url) target = tabs.find(t => t.url === url || t.url.startsWith(url));
    if (!target) target = tabs.find(t => t.title === url);
    if (!target) {
      return { ok: false, error: `No tab found matching "${url || tabId}". Available tabs:\n${tabs.map(t => `  ${t.id}: ${t.url} — "${t.title}"`).join("\n")}` };
    }
    // Update lastActiveTab so getTargetTab() picks this one
    this.getLastActiveTabId = () => target.id;
    return { ok: true, tabId: target.id, url: target.url, title: target.title };
  }

  waitForTabLoad(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") setTimeout(finish, 400); };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then(t => { if (t.status === "complete") setTimeout(finish, 400); }).catch(finish);
      setTimeout(finish, timeoutMs);
    });
  }

  async screenshot({ maxWidth = 1024, quality = 68 } = {}) {
    const tab = await this.requireTab();
    // captureVisibleTab only sees the window's visible tab
    const fresh = await chrome.tabs.get(tab.id);
    const win = await chrome.windows.get(fresh.windowId);
    if (!fresh.active || !win.focused) {
      return { ok: false, error: "The group's tab is not currently visible on screen — screenshot impossible. Use snapshot/get_text (they work in the background) or ask the user to return to the tab." };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(fresh.windowId, { format: "jpeg", quality: 80 });
    const scaled = await this.downscale(dataUrl, maxWidth, quality);
    return { ok: true, dataUrl: scaled.dataUrl, width: scaled.width, height: scaled.height };
  }

  async downscale(dataUrl, maxWidth, quality) {
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, width: w, height: h };
  }

  // ---------- dispatcher for the agent loop ----------
  async run(action) {
    const { tool, ...args } = action;
    try {
      if (CONTENT_CMDS.has(tool)) {
        const res = await this.sendToContent(tool, args);
        return res ?? { ok: false, error: "No response from the page." };
      }
      switch (tool) {
        case "navigate": return await this.navigate(args);
        case "back": return await this.goBack(args);
        case "new_tab": return await this.newTab(args);
        case "tab_info": return await this.tabInfo();
        case "switch_tab": return await this.switchTab(args);
        case "screenshot": return await this.screenshot(args);
        case "wait": {
          const ms = Math.min(Number(args.ms) || 1500, 10000);
          await new Promise(r => setTimeout(r, ms));
          return { ok: true, waitedMs: ms };
        }
        default: return { ok: false, error: `Unknown tool: ${tool}` };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
}

// Action description for display in the transcript (chip)
export function describeAction(a) {
  const t = (s, n = 60) => (s && String(s).length > n ? String(s).slice(0, n) + "…" : s);
  switch (a.tool) {
    case "click": return `🖱️ Click: ${t(a.ref || a.selector || "?")}`;
    case "fill": return `⌨️ Type into ${t(a.ref || a.selector || "?")}: "${t(a.value, 40)}"`;
    case "press": return `⌨️ Key: ${a.key}`;
    case "select_option": return `☑️ Select: ${t(a.label ?? a.value ?? "?")}`;
    case "scroll": return a.to ? `🧭 Scroll: ${a.to}` : `🧭 Scroll page`;
    case "navigate": return `🌐 Navigate: ${t(a.url, 70)}`;
    case "back": return `↩️ Back`;
    case "new_tab": return `🗂️ New tab in group: ${t(a.url || "", 60)}`;
    case "snapshot": return `👀 Reading page layout`;
    case "get_text": return `📄 Reading page content`;
    case "screenshot": return `📸 Screenshot`;
    case "find": return `🔍 Find: "${t(a.query, 50)}"`;
    case "wait_for": return `⏳ Wait for: ${t(a.selector || a.text || "…", 50)}`;
    case "wait": return `⏳ Wait ${a.ms || 1500}ms`;
    case "tab_info": return `ℹ️ Check group tabs`;
    case "switch_tab": return `🔀 Switch tab: ${t(a.url || String(a.tabId || "?"), 50)}`;
    case "highlight": return `✨ Highlight element`;
    default: return `🔧 ${a.tool}`;
  }
}

// Sensitive action heuristics — always require confirmation.
export function isSensitiveAction(a, lastSnapshot = "") {
  if (a.tool === "fill") {
    if (/password|cvc|cvv|card/i.test(String(a.ref) + " " + String(a.selector || ""))) return true;
    if (lastSnapshot && a.ref) {
      const line = lastSnapshot.split("\n").find(l => l.startsWith(a.ref + " "));
      if (line && /password|value=•••|cc-|card/i.test(line)) return true;
    }
  }
  if (a.tool === "click" && lastSnapshot && a.ref) {
    const line = lastSnapshot.split("\n").find(l => l.startsWith(a.ref + " "));
    if (line && /(pay|buy|purchase|order now|checkout|send|submit|delete|confirm|transfer)/i.test(line)) return true;
  }
  return false;
}
