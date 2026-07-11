// Browser tool executor — CDP-first with content script fallback.
// Uses chrome.debugger API (Chrome DevTools Protocol) for native OS-level events:
// - Input.dispatchMouseEvent for clicks (like Puppeteer)
// - Input.dispatchKeyEvent for keyboard
// - Page.captureScreenshot (works on ANY tab, not just visible)
// - Runtime.evaluate for DOM/snapshot (no active tab needed)
//
// Falls back to content script when CDP is unavailable (e.g. restricted URLs,
// user detached debugger, DevTools open on the tab).

import { CDPController } from "./cdp.js";

const CONTENT_CMDS = new Set([
  "snapshot", "get_text", "page_info", "click", "fill", "press",
  "select_option", "scroll", "find", "wait_for", "highlight", "working_indicator",
  "eval_js", "hover",
]);

const RESTRICTED_URL = /^(chrome|chrome-extension|edge|devtools|about|view-source|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com):?/i;

export class BrowserTools {
  constructor({ groupId, getLastActiveTabId }) {
    this.groupId = groupId;
    this.getLastActiveTabId = getLastActiveTabId || (() => null);
    this.cdp = new CDPController();
    this._cdpEnabled = true; // can be toggled off if user detaches debugger

    // Listen for CDP detach events
    chrome.runtime.onMessage?.addListener((msg) => {
      if (msg?.__ocx && msg.cmd === "cdp-detach") {
        this.cdp.attached.delete(msg.tabId);
      }
    });
  }

  async getTargetTab() {
    const tabs = await chrome.tabs.query({ groupId: this.groupId });
    if (!tabs.length) return null;
    if (this._workerTabId) {
      const wt = tabs.find(t => t.id === this._workerTabId);
      if (wt) return wt;
    }
    const last = tabs.find(t => t.id === this.getLastActiveTabId());
    if (last) return last;
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused && focused.groupId === this.groupId) return focused;
    return tabs.reduce((newest, t) => (t.id > newest.id ? t : newest), tabs[0]);
  }

  async requireTab() {
    const tab = await this.getTargetTab();
    if (!tab) throw new Error("No tabs left in the group.");
    if (RESTRICTED_URL.test(tab.url || "")) {
      throw new Error(`Can't operate on this page (${tab.url}). Switch to a regular web page.`);
    }
    return tab;
  }

  /** Try CDP first, fall back to content script. */
  async sendToContent(cmd, args = {}) {
    const tab = await this.requireTab();

    // Try CDP first (for commands that have CDP equivalents)
    if (this._cdpEnabled) {
      try {
        const result = await this._cdpCommand(tab.id, cmd, args);
        if (result) return result;
      } catch (e) {
        // CDP failed — fall through to content script
        console.warn(`[CDP] ${cmd} failed, falling back to content script:`, e.message);
      }
    }

    // Fallback: content script
    const msg = { __ocx: true, cmd, args };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, msg);
        return res ?? { ok: false, error: "No response from the page." };
      } catch {
        if (attempt < 2) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
          } catch { /* already injected */ }
          await new Promise(r => setTimeout(r, 300 + attempt * 400));
        } else {
          throw new Error(`Can't connect to the page after ${attempt + 1} attempts.`);
        }
      }
    }
  }

  /** Dispatch a command to CDP. Returns null if command not supported via CDP. */
  async _cdpCommand(tabId, cmd, args) {
    switch (cmd) {
      case "snapshot":
        return await this.cdp.getSnapshot(tabId, args);
      case "get_text":
        return await this.cdp.getText(tabId, args);
      case "page_info":
        return await this.cdp.getPageInfo(tabId);
      case "click":
        return await this.cdp.clickByRef(tabId, args.ref || args.selector, { dblclick: args.dblclick });
      case "fill":
        return await this.cdp.fillByRef(tabId, args.ref || args.selector, args.value, args);
      case "press":
        return await this.cdp.pressKey(tabId, args.key);
      case "select_option":
        return await this.cdp.selectOption(tabId, args.ref || args.selector, args);
      case "scroll":
        return await this.cdp.scroll(tabId, args);
      case "find":
        return await this.cdp.find(tabId, args.query, args.max);
      case "wait_for":
        return await this.cdp.waitFor(tabId, args);
      default:
        return null; // not supported via CDP
    }
  }

  // ---------- tab-level tools (same as before, use chrome.tabs API) ----------

  async navigate({ url }) {
    if (!url) throw new Error("Missing URL.");
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const tab = await this.requireTab();

    // CDP Page.navigate does NOT activate the tab — stays in background
    if (this._cdpEnabled) {
      try {
        const result = await this.cdp.navigate(tab.id, url);
        if (result.ok) {
          const t = await chrome.tabs.get(tab.id);
          return { ok: true, url: t.url, title: t.title };
        }
      } catch { /* fall through */ }
    }

    // Fallback: chrome.tabs.update — may activate tab in another window
    // but we have no choice without CDP
    await chrome.tabs.update(tab.id, { url });
    await this.waitForTabLoad(tab.id, 20000);
    const t = await chrome.tabs.get(tab.id);
    return { ok: true, url: t.url, title: t.title };
  }

  async goBack() {
    const tab = await this.requireTab();
    // CDP: use Runtime.evaluate to call history.back() — no tab activation
    if (this._cdpEnabled) {
      try {
        await this.cdp.send(tab.id, "Runtime.evaluate", {
          expression: "history.back()",
          returnByValue: true,
        });
        await this.waitForTabLoad(tab.id, 15000);
        const t = await chrome.tabs.get(tab.id);
        return { ok: true, url: t.url, title: t.title };
      } catch { /* fall through */ }
    }
    await chrome.tabs.goBack(tab.id).catch(() => { throw new Error("Can't go back."); });
    await this.waitForTabLoad(tab.id, 15000);
    const t = await chrome.tabs.get(tab.id);
    return { ok: true, url: t.url, title: t.title };
  }

  async newTab({ url }) {
    // Create tab with active:false — stays in background
    const current = await this.getTargetTab();
    const t = await chrome.tabs.create({
      url: url ? (/^https?:\/\//i.test(url) ? url : "https://" + url) : "about:blank",
      active: false,
      windowId: current?.windowId,
    });
    await chrome.tabs.group({ tabIds: [t.id], groupId: this.groupId });
    if (url) await this.waitForTabLoad(t.id, 20000);
    this._workerTabId = t.id;
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

  async switchTab({ url, tabId }) {
    const tabs = await chrome.tabs.query({ groupId: this.groupId });
    let target = null;
    if (tabId) target = tabs.find(t => t.id === tabId);
    if (!target && url) target = tabs.find(t => t.url === url || t.url.startsWith(url));
    if (!target) target = tabs.find(t => t.title === url);
    if (!target) {
      return { ok: false, error: `No tab found matching "${url || tabId}". Available tabs:\n${tabs.map(t => `  ${t.id}: ${t.url} — "${t.title}"`).join("\n")}` };
    }
    this.getLastActiveTabId = () => target.id;
    return { ok: true, tabId: target.id, url: target.url, title: target.title };
  }

  waitForTabLoad(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); } };
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") setTimeout(finish, 600);
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then(t => {
        if (t.status === "complete") setTimeout(finish, 600);
      }).catch(finish);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  /** Screenshot via CDP (any tab) or captureVisibleTab fallback. */
  async screenshot({ maxWidth = 1024, quality = 68 } = {}) {
    const tab = await this.requireTab();

    // Try CDP first — works on ANY tab, not just visible
    if (this._cdpEnabled) {
      try {
        const result = await this.cdp.screenshot(tab.id, { maxWidth, quality });
        if (result.ok) return result;
      } catch { /* fall through */ }
    }

    // Fallback: captureVisibleTab (requires visible + focused window)
    const fresh = await chrome.tabs.get(tab.id);
    const win = await chrome.windows.get(fresh.windowId);
    if (!fresh.active || !win.focused) {
      return { ok: false, error: "Tab not visible — CDP unavailable and captureVisibleTab requires active tab." };
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

  // ---------- dispatcher ----------

  /**
   * Normalize tool name — LLMs frequently invent aliases like setValue, press_key,
   * type, eval, hover, go_back, close_tab. Map them to our canonical names.
   */
  static TOOL_ALIASES = {
    // Common LLM inventions → canonical names
    "set_value": "fill", "setvalue": "fill", "type": "fill", "input": "fill", "write": "fill",
    "press_key": "press", "presskey": "press", "key": "press", "keypress": "press", "keydown": "press",
    "scroll_element_into_view": "scroll", "scroll_into_view": "scroll",
    "go_back": "back", "goback": "back", "history_back": "back",
    "go_forward": "forward", "goforward": "forward", "history_forward": "forward",
    "close_tab": "close", "closetab": "close", "close_page": "close",
    "take_screenshot": "screenshot", "capture": "screenshot", "snap": "snapshot",
    "read_page": "get_text", "read_text": "get_text", "extract_text": "get_text",
    "page_snapshot": "snapshot", "dom_snapshot": "snapshot", "get_elements": "snapshot",
    "get_info": "tab_info", "page_info": "tab_info",
    "wait_for": "wait_for", "waitfor": "wait_for",
    "evaluate": "eval", "run_js": "eval", "execute": "eval", "javascript": "eval",
  };

  async run(action) {
    let { tool, ...args } = action;
    // Normalize: LLMs often pass `selector` instead of `ref`
    if (!args.ref && args.selector) {
      args.ref = args.selector;
      delete args.selector;
    }
    // Normalize tool name via aliases
    const norm = String(tool || "").toLowerCase().replace(/\s+/g, "_");
    tool = BrowserTools.TOOL_ALIASES[norm] || tool;

    try {
      if (CONTENT_CMDS.has(tool)) {
        const res = await this.sendToContent(tool, args);
        return res ?? { ok: false, error: "No response from the page." };
      }
      switch (tool) {
        case "navigate": return await this.navigate(args);
        case "back": return await this.goBack(args);
        case "forward": return await this.goForward(args);
        case "new_tab": return await this.newTab(args);
        case "close": return await this.closeTab(args);
        case "tab_info": return await this.tabInfo();
        case "switch_tab": return await this.switchTab(args);
        case "screenshot": return await this.screenshot(args);
        case "eval": return await this.eval(args);
        case "hover": return await this.hover(args);
        case "wait": {
          const ms = Math.min(Number(args.ms) || 1500, 10000);
          await new Promise(r => setTimeout(r, ms));
          return { ok: true, waitedMs: ms };
        }
        default: {
          // Helpful error: list available tools
          const available = [
            "snapshot", "get_text", "screenshot", "click", "fill", "press",
            "select_option", "scroll", "find", "wait_for", "wait",
            "navigate", "back", "forward", "new_tab", "close",
            "tab_info", "switch_tab", "eval", "hover",
          ].join(", ");
          return { ok: false, error: `Unknown tool: "${action.tool}". Available tools: ${available}` };
        }
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // ---------- new tools ----------

  /** Go forward in history. */
  async goForward() {
    const tab = await this.requireTab();
    await chrome.tabs.goForward(tab.id).catch(() => { throw new Error("Can't go forward."); });
    await this.waitForTabLoad(tab.id, 15000);
    const t = await chrome.tabs.get(tab.id);
    return { ok: true, url: t.url, title: t.title };
  }

  /** Close the current tab and switch to the next one in the group. */
  async closeTab() {
    const tab = await this.requireTab();
    const all = await chrome.tabs.query({ groupId: this.groupId });
    if (all.length <= 1) return { ok: false, error: "Can't close the last tab in the group." };
    await chrome.tabs.remove(tab.id);
    this._workerTabId = null;
    const next = await this.getTargetTab();
    return { ok: true, closed: tab.url, switchedTo: next?.url || "none" };
  }

  /** Execute arbitrary JavaScript on the page via CDP or content script. */
  async eval({ code, expression }) {
    const expr = code || expression;
    if (!expr) return { ok: false, error: "Provide 'code' or 'expression' to evaluate." };
    const tab = await this.requireTab();

    // Try CDP first
    if (this._cdpEnabled) {
      try {
        const result = await this.cdp.send(tab.id, "Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result?.exceptionDetails) {
          return { ok: false, error: result.exceptionDetails.text || "JS error" };
        }
        return { ok: true, result: result?.result?.value };
      } catch { /* fall through */ }
    }

    // Fallback: content script eval
    const res = await this.sendToContent("eval_js", { code: expr });
    return res;
  }

  /** Hover over an element (mouse move to center). */
  async hover({ ref }) {
    const tab = await this.requireTab();
    if (this._cdpEnabled) {
      try {
        const coords = await this.cdp.getElementCoords(tab.id, ref);
        if (!coords.ok) return coords;
        await this.cdp.send(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: coords.x, y: coords.y,
        });
        return { ok: true, hovered: coords.desc };
      } catch { /* fall through */ }
    }
    return this.sendToContent("hover", { ref });
  }
}

// Action description for display in the transcript (chip)
export function describeAction(a) {
  const t = (s, n = 60) => (s && String(s).length > n ? String(s).slice(0, n) + "…" : s);
  const norm = String(a.tool || "").toLowerCase().replace(/\s+/g, "_");
  const canon = BrowserTools.TOOL_ALIASES[norm] || a.tool;
  switch (canon) {
    case "click": return `🖱️ Click: ${t(a.ref || a.selector || "?")}`;
    case "fill": return `⌨️ Type into ${t(a.ref || a.selector || "?")}: "${t(a.value, 40)}"`;
    case "press": return `⌨️ Key: ${a.key}`;
    case "select_option": return `☑️ Select: ${t(a.label ?? a.value ?? "?")}`;
    case "scroll": return a.to ? `🧭 Scroll: ${a.to}` : `🧭 Scroll page`;
    case "navigate": return `🌐 Navigate: ${t(a.url, 70)}`;
    case "back": return `↩️ Back`;
    case "forward": return `↪️ Forward`;
    case "new_tab": return `🗂️ New tab in group: ${t(a.url || "", 60)}`;
    case "close": return `❌ Close tab`;
    case "snapshot": return `👀 Reading page layout`;
    case "get_text": return `📄 Reading page content`;
    case "screenshot": return `📸 Screenshot`;
    case "find": return `🔍 Find: "${t(a.query, 50)}"`;
    case "wait_for": return `⏳ Wait for: ${t(a.selector || a.text || "…", 50)}`;
    case "wait": return `⏳ Wait ${a.ms || 1500}ms`;
    case "hover": return `🎯 Hover: ${t(a.ref || a.selector || "?")}`;
    case "eval": return `💻 Eval JS: ${t(a.code || a.expression || "", 50)}`;
    case "tab_info": return `ℹ️ Check group tabs`;
    case "switch_tab": return `🔀 Switch tab: ${t(a.url || String(a.tabId || "?"), 50)}`;
    case "multi_step": return `🤖 Worker task: ${t(a.goal || a.intent || "?", 50)}`;
    case "quick_action": return `⚡ Quick: ${t(a.intent || a.text || "?", 50)}`;
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
