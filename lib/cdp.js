// CDP (Chrome DevTools Protocol) wrapper — uses chrome.debugger API.
// This gives us Puppeteer-level control: native clicks, screenshots on any tab,
// DOM access without active tab requirement, keyboard events via Input domain.
//
// The user will see Chrome's yellow bar: "Andrzej started debugging this browser"
// — same as Claude and Puppeteer show. This is expected behavior.
//
// The embedded JS strings evaluated in-page via Runtime.evaluate live in
// ./cdp/injected.js, so this file stays focused on the CDP command flow.

import {
  SMOOTH_SCROLL_JS,
  resolveRefFnSource,
  focusGuardSource,
  focusGuardSourceForNewDocument,
  legacySnapshotSource,
  buildLegacyRefsSource,
} from "./cdp/injected.js";

const RESTRICTED_URL = /^(chrome|chrome-extension|edge|devtools|about|view-source|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com):?/i;

export class CDPController {
  constructor() {
    this.attached = new Set(); // tabIds we're currently attached to
    this.pendingEvents = new Map(); // tabId -> { method -> callback[] }
    this._attachQueue = Promise.resolve(); // serializes concurrent attach calls
  }

  /** Attach debugger to a tab. Idempotent — safe to call multiple times.
   *  Serialized via a promise queue to prevent concurrent chrome.debugger.attach
   *  calls from failing (Chrome's debugger API doesn't handle parallel attach
   *  requests well — multiple workers starting simultaneously can cause "another
   *  debugger is already attached" or silent failures). */
  async attach(tabId) {
    if (this.attached.has(tabId)) return true;
    // Serialize: chain onto the queue so only one attach runs at a time
    const prev = this._attachQueue;
    let resolve;
    this._attachQueue = new Promise((r) => { resolve = r; });
    await prev;
    try {
      if (this.attached.has(tabId)) return true; // re-check after waiting
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attached.add(tabId);
      // Enable domains we need
      await this.send(tabId, "DOM.enable");
      await this.send(tabId, "Page.enable");
      await this.send(tabId, "Runtime.enable");
      await this.send(tabId, "Network.enable");
      // Inject anti-focus-hijack into the CURRENT page (already loaded).
      // addScriptToEvaluateOnNewDocument only runs on FUTURE navigations,
      // so we also need to patch the current document immediately.
      await this.send(tabId, "Runtime.evaluate", {
        expression: focusGuardSource(),
        returnByValue: true,
      });
      // Also inject for future navigations on this tab
      await this.send(tabId, "Page.addScriptToEvaluateOnNewDocument", {
        source: focusGuardSourceForNewDocument(),
      });
      return true;
    } catch (e) {
      console.warn(`[CDP] attach failed for tab ${tabId}:`, e.message);
      return false;
    } finally {
      resolve();
    }
  }

  /** Detach from a tab. Safe to call even if not attached. */
  async detach(tabId) {
    if (!this.attached.has(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch { /* already detached */ }
    this.attached.delete(tabId);
    this.pendingEvents.delete(tabId);
  }

  /** Detach from all tabs. */
  async detachAll() {
    for (const tabId of this.attached) {
      await this.detach(tabId);
    }
  }

  /** Send a CDP command to a tab. Auto-attaches if needed. */
  async send(tabId, method, params = {}) {
    if (!this.attached.has(tabId)) {
      const ok = await this.attach(tabId);
      if (!ok) throw new Error(`Cannot attach debugger to tab ${tabId}`);
    }
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (e) {
      // If detached (e.g. user closed tab), try re-attaching once
      if (e.message?.includes("Detached") || e.message?.includes("Target closed")) {
        this.attached.delete(tabId);
        const ok = await this.attach(tabId);
        if (!ok) throw new Error(`Tab ${tabId} is no longer available`);
        return await chrome.debugger.sendCommand({ tabId }, method, params);
      }
      throw e;
    }
  }

  /** Wait for a specific CDP event on a tab. */
  waitForEvent(tabId, method, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);

      const listener = (source, evtMethod, params) => {
        if (source.tabId === tabId && evtMethod === method) {
          clearTimeout(timer);
          chrome.debugger.onEvent.removeListener(listener);
          resolve(params);
        }
      };

      chrome.debugger.onEvent.addListener(listener);
    });
  }

  // ---------- High-level operations ----------

  /** Get page snapshot via CDP — uses accessibility tree if available. */
  async getSnapshot(tabId, { maxChars = 50000, filter = 'interactive', refId = null } = {}) {
    // Try to call window.__generateAccessibilityTree (injected by accessibility-tree.js in MAIN world)
    const treeExpr = refId
      ? `window.__generateAccessibilityTree && window.__generateAccessibilityTree(${JSON.stringify(filter)}, 15, ${maxChars}, ${JSON.stringify(refId)})`
      : `window.__generateAccessibilityTree && window.__generateAccessibilityTree(${JSON.stringify(filter)}, 15, ${maxChars})`;

    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const header = [
          'URL: ' + location.href,
          'TITLE: ' + document.title,
        ];
        const scrollPct = document.documentElement.scrollHeight <= innerHeight ? 100 :
          Math.round((scrollY + innerHeight) / document.documentElement.scrollHeight * 100);
        header.push('VIEWPORT: scrolled to ' + scrollPct + '% (scrollY=' + Math.round(scrollY) + ', pageHeight=' + document.documentElement.scrollHeight + ')');
        header.push('');

        ${treeExpr};
        const treeResult = ${treeExpr};
        if (!treeResult) {
          // Accessibility tree not available — use legacy inline snapshot
          return { ok: true, snapshot: header.join('\\n') + legacySnapshot(${maxChars}) };
        }
        if (treeResult.error) return { ok: false, error: treeResult.error };
        return { ok: true, snapshot: header.join('\\n') + treeResult.pageContent };

        ${legacySnapshotSource()}
      })()`,
      returnByValue: true,
    });

    if (result?.exceptionDetails) {
      return { ok: false, error: "JS eval failed: " + (result.exceptionDetails.text || "unknown") };
    }

    const snapshot = result?.result?.value;
    if (!snapshot) return { ok: false, error: "No snapshot result" };
    return snapshot;
  }

  /** Click at coordinates via CDP Input domain — native OS-level click. */
  async clickAtCoords(tabId, x, y, { dblclick = false } = {}) {
    const base = { x, y, button: "left" };
    // pointerdown
    await this.send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 });
    // pointerup
    await this.send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 1 });
    if (dblclick) {
      await this.send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 2 });
      await this.send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 2 });
    }
    // Wait for network idle + rendering flush — critical for SPAs (AliExpress, Amazon, etc.)
    // that fetch on click and render elements asynchronously after network settles.
    await this.waitForNetworkIdle(tabId, 500, 3000).catch(() => {});
    await this.waitForRenderFlush(tabId);
    return { ok: true };
  }

  /** Wait for the page's rendering pipeline to flush after network idle.
   *  SPAs often update DOM in requestAnimationFrame or setTimeout after XHR completes.
   *  Without this flush, snapshot may miss dynamically rendered buttons/elements.
   *
   *  IMPORTANT: requestAnimationFrame does NOT fire when the tab is hidden (background).
   *  Chrome suspends rAF entirely in inactive tabs, so a Promise waiting on rAF would
   *  hang forever until the user reactivates the tab — making the agent appear "stuck".
   *  When the document is hidden we fall back to setTimeout (which is throttled but still
   *  fires), so background navigation/clicks complete without needing the tab to be open. */
  async waitForRenderFlush(tabId, delayMs = 400) {
    try {
      await this.send(tabId, "Runtime.evaluate", {
        expression: `new Promise(resolve => {
          if (document.hidden) {
            setTimeout(() => setTimeout(resolve, ${delayMs}), 50);
          } else {
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, ${delayMs})));
          }
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
    } catch { /* non-critical — page may have navigated away */ }
  }

  /** Click an element by ref — smart: for <a> links, navigate via CDP instead of clicking
   *  (avoids target="_blank" focus stealing). For other elements, use CDP Input.dispatchMouseEvent. */
  async clickByRef(tabId, ref, { dblclick = false } = {}) {
    // Check if it's an <a> with href — navigate via CDP instead of clicking
    const linkInfo = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const _ref = '${ref}';
        ${resolveRefFnSource()}
        const el = resolveRef(_ref);
        if (!el || !el.isConnected) return { ok: false, error: 'Element ' + _ref + ' not found.' };
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) {
          const aria = el.getAttribute('aria-label') || el.textContent || '';
          return { ok: true, isLink: true, href: el.href, desc: 'a "' + String(aria).slice(0, 60) + '"' };
        }
        if (el.getAttribute('onclick')?.includes('window.open')) {
          return { ok: true, hasWindowOpen: true };
        }
        return { ok: true, isLink: false };
      })()`,
      returnByValue: true,
    });

    const info = linkInfo?.result?.value;

    // For <a> links: navigate via CDP Page.navigate (no tab activation, no focus stealing)
    if (info?.isLink && !dblclick) {
      const navResult = await this.navigate(tabId, info.href);
      return { ...navResult, clicked: info.desc, navigated: true };
    }

    // For other elements: use CDP Input.dispatchMouseEvent (native click)
    // Strip target="_blank" just in case
    await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        function resolveEl(r) {
          if (window.__ocxElementMap && r.startsWith('ref_')) {
            const weak = window.__ocxElementMap[r];
            return weak ? weak.deref() : null;
          }
          return window.__ocxRefs?.get(r) || null;
        }
        const el = resolveEl('${ref}');
        if (el?.tagName === 'A' && el.target === '_blank') el.target = '_self';
      })()`,
      returnByValue: true,
    });

    const coords = await this.getElementCoords(tabId, ref);
    if (!coords.ok) return coords;
    const result = await this.clickAtCoords(tabId, coords.x, coords.y, { dblclick });
    return { ...result, clicked: coords.desc };
  }

  /** Get element center coordinates by ref (ref_N or eN). */
  async getElementCoords(tabId, ref) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        ${resolveRefFnSource()}
        const _ref = '${ref}';
        // If legacy refs not built yet, build them
        ${buildLegacyRefsSource()}
        const el = resolveRef(_ref);
        if (!el || !el.isConnected) return { ok: false, error: 'Element ' + _ref + ' not found. Take a new snapshot.' };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || '';
        return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, desc: el.tagName.toLowerCase() + ' "' + String(aria).slice(0, 60) + '"' };
      })()`,
      returnByValue: true,
    });

    if (result?.exceptionDetails) {
      return { ok: false, error: "Eval failed" };
    }
    return result?.result?.value || { ok: false, error: "No result" };
  }

  /** Fill a text input by ref via CDP. */
  async fillByRef(tabId, ref, value, { clear = true, pressEnter = false } = {}) {
    // First: physically click the element to focus it (some SPAs block programmatic focus)
    const coords = await this.getElementCoords(tabId, ref);
    if (coords.ok) {
      await this.clickAtCoords(tabId, coords.x, coords.y);
      await new Promise(r => setTimeout(r, 100));
    }

    // Focus and clear via JS (as backup — the click above usually handles focus)
    const focusResult = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const _ref = '${ref}';
        ${resolveRefFnSource()}
        const el = resolveRef(_ref);
        if (!el || !el.isConnected) return { ok: false, error: 'Element ' + _ref + ' not found.' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus({ preventScroll: true });
        if (${clear} && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
          if (el.isContentEditable) {
            el.textContent = '';
          } else {
            // Clear via native input setter to trigger React/Vue watchers
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, '');
            } else {
              el.value = '';
            }
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true };
      })()`,
      returnByValue: true,
    });

    // If focus/clear failed but click worked, we can still type
    if (focusResult?.exceptionDetails) {
      // Click worked but JS focus failed — we can still type via Input domain
      // since the physical click already focused the element
    } else if (!focusResult?.result?.value?.ok) {
      return focusResult?.result?.value || { ok: false, error: "Focus failed" };
    }

    // Type text via Input domain — native keystrokes
    if (value) {
      await this.send(tabId, "Input.insertText", { text: value });
    }

    // Trigger change event
    await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const _ref = '${ref}';
        ${resolveRefFnSource()}
        const el = resolveRef(_ref);
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
      returnByValue: true,
    });

    if (pressEnter) {
      await new Promise(r => setTimeout(r, 60));
      await this.pressKey(tabId, "Enter");
    }

    return { ok: true, filled: ref, valueLength: value.length };
  }

  /** Press a key via CDP Input.dispatchKeyEvent. */
  async pressKey(tabId, key) {
    const KEYMAP = {
      "enter": { key: "Enter", code: "Enter", keyCode: 13 },
      "tab": { key: "Tab", code: "Tab", keyCode: 9 },
      "escape": { key: "Escape", code: "Escape", keyCode: 27 },
      "esc": { key: "Escape", code: "Escape", keyCode: 27 },
      "backspace": { key: "Backspace", code: "Backspace", keyCode: 8 },
      "delete": { key: "Delete", code: "Delete", keyCode: 46 },
      "space": { key: " ", code: "Space", keyCode: 32 },
      "arrowup": { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      "arrowdown": { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      "arrowleft": { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      "arrowright": { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      "pageup": { key: "PageUp", code: "PageUp", keyCode: 33 },
      "pagedown": { key: "PageDown", code: "PageDown", keyCode: 34 },
      "home": { key: "Home", code: "Home", keyCode: 36 },
      "end": { key: "End", code: "End", keyCode: 35 },
    };

    const norm = String(key || "").toLowerCase().replace(/\s/g, "");
    const info = KEYMAP[norm] || { key, code: key, keyCode: 0 };

    await this.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...info });
    await this.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...info });

    return { ok: true, pressed: key };
  }

  /** Screenshot via CDP Page.captureScreenshot — works on ANY tab, not just visible. */
  async screenshot(tabId, { format = "jpeg", quality = 80, maxWidth = 1024 } = {}) {
    const result = await this.send(tabId, "Page.captureScreenshot", {
      format,
      quality,
      captureBeyondViewport: false,
    });
    if (!result?.data) return { ok: false, error: "No screenshot data" };

    // Decode and resize
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: `image/${format}` });

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
    const buf = new Uint8Array(await outBlob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));

    return { ok: true, dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, width: w, height: h };
  }

  /** Navigate via CDP Page.navigate. */
  async navigate(tabId, url) {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const result = await this.send(tabId, "Page.navigate", { url });
    if (result?.errorText) return { ok: false, error: result.errorText };

    // Wait for load
    try {
      await this.waitForEvent(tabId, "Page.loadEventFired", 20000);
    } catch { /* timeout — page may still work */ }
    // Wait for network idle (no requests for 500ms) — critical for SPA sites
    // like AliExpress that load content dynamically via XHR/fetch
    await this.waitForNetworkIdle(tabId, 500, 5000);
    // Wait for rendering flush — SPAs update DOM in rAF/setTimeout after network settles
    await this.waitForRenderFlush(tabId);

    return { ok: true, url };
  }

  /** Wait for network idle — no MAIN network requests for `quietMs` milliseconds.
   *  Ignores common trackers/ads/beacons that fire constantly on SPAs like AliExpress.
   *  Always resolves within timeoutMs (default 3s) to prevent infinite hangs. */
  async waitForNetworkIdle(tabId, quietMs = 300, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let lastActivity = Date.now();
      let resolved = false;
      const TRACKER_PATTERNS = /analytics|beacon|pixel|track|log|report|metric|telemetry|ads|adserver|collect|batch|hot-update|keepalive|ping|heartbeat/i;
      const done = () => { if (!resolved) { resolved = true; clearInterval(checker); chrome.debugger.onEvent.removeListener(listener); resolve(); } };
      const listener = (source, method, params) => {
        if (source.tabId !== tabId) return;
        if (method === "Network.requestWillBeSent") {
          // Ignore tracker/analytics/beacon requests — only count "real" requests
          const url = params?.request?.url || "";
          if (TRACKER_PATTERNS.test(url)) return;
          lastActivity = Date.now();
        }
      };
      chrome.debugger.onEvent.addListener(listener);
      const checker = setInterval(() => {
        if (Date.now() - lastActivity >= quietMs) done();
      }, 100);
      setTimeout(done, timeoutMs);
    });
  }

  /** Smooth, human-like scrolling driven in-page (continuous small steps, not big jumps). */
  async scroll(tabId, { ref, to, dy } = {}) {
    if (ref) {
      // Smoothly bring an element into view.
      await this.send(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const _ref = '${ref}';
          function resolveRef(r) {
            if (window.__ocxElementMap && r.startsWith('ref_')) {
              const weak = window.__ocxElementMap[r];
              return weak ? weak.deref() : null;
            }
            return window.__ocxRefs?.get(r) || null;
          }
          const el = resolveRef(_ref);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        })()`,
        returnByValue: true,
      });
      await new Promise(r => setTimeout(r, 500)); // let the smooth animation finish
      return this.getPageInfo(tabId);
    }

    if (to === "top") {
      await this.send(tabId, "Runtime.evaluate", {
        awaitPromise: true, returnByValue: true,
        expression: SMOOTH_SCROLL_JS("top"),
      });
      return this.getPageInfo(tabId);
    }

    if (to === "bottom") {
      // Continuous, small-increment scroll to the bottom driven entirely in-page so the motion
      // is smooth (like a person dragging the scrollbar), not chunky per-step jumps. Pauses at
      // the bottom so lazy-loaded / virtualized content can render, and keeps going while the
      // page height grows — finishing only once the height is stable. See SMOOTH_SCROLL_JS.
      await this.send(tabId, "Runtime.evaluate", {
        awaitPromise: true, returnByValue: true,
        expression: SMOOTH_SCROLL_JS("bottom"),
      });
      return this.getPageInfo(tabId);
    }

    // Default: smooth scroll down by a chunk (dy px, or ~0.6 viewport).
    await this.send(tabId, "Runtime.evaluate", {
      awaitPromise: true, returnByValue: true,
      expression: SMOOTH_SCROLL_JS("by", dy),
    });
    return this.getPageInfo(tabId);
  }

  /** Get page info via CDP. */
  async getPageInfo(tabId) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => ({
        ok: true,
        url: location.href,
        title: document.title,
        scrollY: Math.round(scrollY),
        pageHeight: document.documentElement.scrollHeight,
        scrollPct: document.documentElement.scrollHeight <= innerHeight ? 100 :
          Math.round((scrollY + innerHeight) / document.documentElement.scrollHeight * 100),
        viewport: { w: innerWidth, h: innerHeight }
      }))()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, error: "No page info" };
  }

  /** Get page text via CDP. */
  async getText(tabId, { maxChars = 20000 } = {}) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        let text = document.body?.innerText || '';
        text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
        const truncated = text.length > ${maxChars};
        if (truncated) text = text.slice(0, ${maxChars}) + '\\n… (truncated)';
        return { ok: true, url: location.href, title: document.title, text, truncated };
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, error: "getText failed" };
  }

  /** Select an option in a <select> via CDP. */
  async selectOption(tabId, ref, { value, label } = {}) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const _ref = '${ref}';
        ${resolveRefFnSource()}
        const el = resolveRef(_ref);
        if (!(el instanceof HTMLSelectElement)) return { ok: false, error: 'Not a <select>' };
        let opt = null;
        if (${JSON.stringify(value)} !== undefined) opt = [...el.options].find(o => o.value === String(${JSON.stringify(value)}));
        if (!opt && ${JSON.stringify(label)}) opt = [...el.options].find(o => o.textContent.trim().toLowerCase().includes(String(${JSON.stringify(label)}).toLowerCase()));
        if (!opt) return { ok: false, error: 'Option not found. Available: ' + [...el.options].map(o => o.textContent.trim()).slice(0, 20).join(' | ') };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: opt.textContent.trim().slice(0, 60) };
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, error: "selectOption failed" };
  }

  /** Find elements by text via CDP. */
  async find(tabId, query, max = 15) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const q = String(${JSON.stringify(query)}).toLowerCase();
        if (!q) return { ok: false, error: 'Provide text to search for.' };
        const results = [];
        // Check accessibility tree refs first
        if (window.__ocxElementMap) {
          for (const [ref, weak] of Object.entries(window.__ocxElementMap)) {
            const el = weak.deref();
            if (!el || !el.isConnected) continue;
            const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').toLowerCase();
            if (name.includes(q)) {
              results.push(ref + ' | ' + el.tagName.toLowerCase() + ' "' + String(name).trim().slice(0, 60) + '"');
              if (results.length >= ${max}) break;
            }
          }
        }
        // Also check legacy refs
        if (window.__ocxRefs) {
          for (const [ref, el] of window.__ocxRefs) {
            if (!el.isConnected) continue;
            const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').toLowerCase();
            if (name.includes(q) && !results.some(r => r.startsWith(ref + ' '))) {
              results.push(ref + ' | ' + el.tagName.toLowerCase() + ' "' + String(name).trim().slice(0, 60) + '"');
              if (results.length >= ${max}) break;
            }
          }
        }
        return { ok: true, matches: results, count: results.length };
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, error: "find failed" };
  }

  /** Wait for element or text via CDP. */
  async waitFor(tabId, { selector, text, timeoutMs = 8000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const result = await this.send(tabId, "Runtime.evaluate", {
        expression: `(() => {
          ${selector ? `if (document.querySelector(${JSON.stringify(selector)})) return { ok: true, found: ${JSON.stringify(selector)} };` : ""}
          ${text ? `if (document.body?.innerText?.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})) return { ok: true, found: ${JSON.stringify("text: " + text)} };` : ""}
          return { ok: false };
        })()`,
        returnByValue: true,
      });
      if (result?.result?.value?.ok) {
        return { ...result.result.value, waitedMs: Date.now() - t0 };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, error: `Timed out waiting for (${selector || text}) in ${timeoutMs}ms.` };
  }
  // ---------- visual indicator control ----------

  /** Show agent indicators (glow border, phantom cursor, stop button). */
  async showIndicators(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { __ocx: true, cmd: 'SHOW_INDICATORS' });
    } catch { /* visual-indicator.js may not be loaded yet */ }
  }

  /** Hide agent indicators. */
  async hideIndicators(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { __ocx: true, cmd: 'HIDE_INDICATORS' });
    } catch { /* ignore */ }
  }

  /** Update phantom cursor position. */
  async updateCursor(tabId, x, y) {
    try {
      await chrome.tabs.sendMessage(tabId, { __ocx: true, cmd: 'UPDATE_CURSOR', x, y });
    } catch { /* ignore */ }
  }

  /** Show static pill ("active in tab group"). */
  async showPill(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { __ocx: true, cmd: 'SHOW_PILL' });
    } catch { /* ignore */ }
  }

  /** Hide static pill. */
  async hidePill(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { __ocx: true, cmd: 'HIDE_PILL' });
    } catch { /* ignore */ }
  }
}

// Handle debugger detach events (user closes tab, opens DevTools, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  // The CDPController instance in background.js will clean up
  // We emit a custom event so tools.js can react
  chrome.runtime.sendMessage?.({ __ocx: true, cmd: "cdp-detach", tabId: source.tabId, reason }).catch(() => {});
});
