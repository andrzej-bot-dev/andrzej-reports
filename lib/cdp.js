// CDP (Chrome DevTools Protocol) wrapper — uses chrome.debugger API.
// This gives us Puppeteer-level control: native clicks, screenshots on any tab,
// DOM access without active tab requirement, keyboard events via Input domain.
//
// The user will see Chrome's yellow bar: "Andrzej started debugging this browser"
// — same as Claude and Puppeteer show. This is expected behavior.

const RESTRICTED_URL = /^(chrome|chrome-extension|edge|devtools|about|view-source|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com):?/i;

export class CDPController {
  constructor() {
    this.attached = new Set(); // tabIds we're currently attached to
    this.pendingEvents = new Map(); // tabId -> { method -> callback[] }
  }

  /** Attach debugger to a tab. Idempotent — safe to call multiple times. */
  async attach(tabId) {
    if (this.attached.has(tabId)) return true;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      this.attached.add(tabId);
      // Enable domains we need
      await this.send(tabId, "DOM.enable");
      await this.send(tabId, "Page.enable");
      await this.send(tabId, "Runtime.enable");
      await this.send(tabId, "Network.enable");
      // Inject anti-focus-hijack script on every new document load.
      // This runs BEFORE any page scripts, so it catches window.open,
      // target="_blank", and window.focus() attempts.
      await this.send(tabId, "Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          if (window.__ocxFocusGuard) return;
          window.__ocxFocusGuard = true;

          // 1. Intercept window.open — replace _blank with _self
          const _origOpen = window.open;
          window.open = function(url, name, features) {
            if (name === '_blank' || !name) name = '_self';
            return _origOpen.call(window, url, name, features);
          };

          // 2. MutationObserver: strip target="_blank" from new <a> elements
          const mo = new MutationObserver((mutations) => {
            for (const m of mutations) {
              for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'A' && node.target === '_blank') node.target = '_self';
                for (const a of node.querySelectorAll?.('a[target="_blank"]') || []) {
                  a.target = '_self';
                }
              }
            }
          });
          mo.observe(document.documentElement, { childList: true, subtree: true });
        })()`,
      });
      return true;
    } catch (e) {
      console.warn(`[CDP] attach failed for tab ${tabId}:`, e.message);
      return false;
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

  /** Get page snapshot via CDP DOM domain — works on ANY tab, even inactive. */
  async getSnapshot(tabId, { maxChars = 24000 } = {}) {
    const doc = await this.send(tabId, "DOM.getDocument", { depth: -1, pierce: true });
    if (!doc?.root) return { ok: false, error: "No document root" };

    // Use Runtime.evaluate to extract structured snapshot from the page itself
    // This runs in the page's isolated world
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const lines = [];
        lines.push('URL: ' + location.href);
        lines.push('TITLE: ' + document.title);
        const scrollPct = document.documentElement.scrollHeight <= innerHeight ? 100 :
          Math.round((scrollY + innerHeight) / document.documentElement.scrollHeight * 100);
        lines.push('VIEWPORT: scrolled to ' + scrollPct + '% (scrollY=' + Math.round(scrollY) + ')');
        lines.push('');
        lines.push('ELEMENTS:');

        const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[role=searchbox],[role=textbox],[contenteditable=true],[contenteditable=plaintext-only],[onclick],[tabindex]';
        const seen = new Set();
        let refCounter = 0;
        let count = 0;

        function clean(s, max) {
          if (!s) return '';
          s = String(s).replace(/\\s+/g, ' ').trim();
          return s.length > max ? s.slice(0, max - 1) + '…' : s;
        }

        for (const el of document.querySelectorAll('h1,h2,h3,' + INTERACTIVE)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;
          if (el.offsetWidth < 2 && el.offsetHeight < 2) continue;

          const tag = el.tagName.toLowerCase();
          if (/^h[1-3]$/.test(tag)) {
            const t = clean(el.textContent, 120);
            if (t) lines.push('── ' + tag.toUpperCase() + ': ' + t);
            continue;
          }

          if (!el.matches(INTERACTIVE)) continue;
          if (tag === 'div' || tag === 'span') {
            const role = el.getAttribute('role');
            const editable = el.isContentEditable;
            const clickable = el.hasAttribute('onclick') || role;
            if (!editable && !clickable) continue;
          }

          refCounter++;
          const ref = 'e' + refCounter;

          let desc = tag;
          if (tag === 'input') desc += '[' + (el.type || 'text') + ']';
          const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
          if (aria) desc += ' "' + clean(aria, 60) + '"';

          const states = [];
          if (el.disabled) states.push('disabled');
          if (el.checked) states.push('checked');
          if (el.selected) states.push('selected');
          if (tag === 'input' || tag === 'textarea') {
            if (el.type === 'password') states.push('value=•••');
            else if (el.value) states.push('value="' + clean(el.value, 60) + '"');
          }
          if (tag === 'select') {
            const opts = [...el.options].slice(0, 12).map(o => (o.selected ? '*' : '') + clean(o.textContent, 30));
            states.push('options=[' + opts.join(', ') + ']');
          }
          if (tag === 'a') {
            const href = el.getAttribute('href');
            if (href && !href.startsWith('javascript:')) states.push('href=' + clean(href, 80));
          }

          let line = ref + ' | ' + desc;
          if (states.length) line += ' | ' + states.join(', ');
          lines.push(line);

          if (++count > 500) { lines.push('… (truncated)'); break; }
          if (lines.join('\\n').length > ${maxChars}) { lines.push('… (truncated)'); break; }
        }

        return lines.join('\\n');
      })()`,
      returnByValue: true,
    });

    if (result?.exceptionDetails) {
      return { ok: false, error: "JS eval failed: " + (result.exceptionDetails.text || "unknown") };
    }

    const snapshot = result?.result?.value || "";
    return { ok: true, snapshot };
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
    return { ok: true };
  }

  /** Click an element by ref — resolve coords via Runtime.evaluate, then click. */
  async clickByRef(tabId, ref, { dblclick = false } = {}) {
    // Before clicking, strip target="_blank" from the element to prevent
    // Chrome from activating a new tab and stealing focus
    await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = window.__ocxRefs?.get('${ref}');
        if (el?.tagName === 'A' && el.target === '_blank') {
          el.target = '_self';
        }
      })()`,
      returnByValue: true,
    });
    const coords = await this.getElementCoords(tabId, ref);
    if (!coords.ok) return coords;
    const result = await this.clickAtCoords(tabId, coords.x, coords.y, { dblclick });
    return { ...result, clicked: coords.desc };
  }

  /** Get element center coordinates by ref (e1, e2, …). */
  async getElementCoords(tabId, ref) {
    const result = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        // We maintain a ref registry in the page via a __ocxRefs map
        if (!window.__ocxRefs) window.__ocxRefs = new Map();
        if (!window.__ocxElToRef) window.__ocxElToRef = new WeakMap();
        if (!window.__ocxRefCounter) window.__ocxRefCounter = 0;

        const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[contenteditable=true],[onclick],[tabindex]';

        // Build refs if not yet built for this page state
        if (window.__ocxRefs.size === 0) {
          let counter = 0;
          for (const el of document.querySelectorAll('h1,h2,h3,' + INTERACTIVE)) {
            if (el.offsetParent === null && el.tagName !== 'BODY') continue;
            if (el.offsetWidth < 2 && el.offsetHeight < 2) continue;
            const tag = el.tagName.toLowerCase();
            if (/^h[1-3]$/.test(tag)) continue;
            if (!el.matches(INTERACTIVE)) continue;
            if (tag === 'div' || tag === 'span') {
              const role = el.getAttribute('role');
              if (!el.isContentEditable && !el.hasAttribute('onclick') && !role) continue;
            }
            counter++;
            const r = 'e' + counter;
            window.__ocxRefs.set(r, el);
            window.__ocxElToRef.set(el, r);
            window.__ocxRefCounter = counter;
          }
        }

        const el = window.__ocxRefs.get('${ref}');
        if (!el || !el.isConnected) return { ok: false, error: 'Element ${ref} not found. Take a new snapshot.' };

        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || '';
        return {
          ok: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          desc: el.tagName.toLowerCase() + ' "' + String(aria).slice(0, 60) + '"'
        };
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
    // Focus and clear via JS
    const focusResult = await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        if (!window.__ocxRefs) return { ok: false, error: 'No refs — take a snapshot first.' };
        const el = window.__ocxRefs.get('${ref}');
        if (!el || !el.isConnected) return { ok: false, error: 'Element ${ref} not found.' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus({ preventScroll: true });
        if (${clear} && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true };
      })()`,
      returnByValue: true,
    });

    if (focusResult?.exceptionDetails || !focusResult?.result?.value?.ok) {
      return focusResult?.result?.value || { ok: false, error: "Focus failed" };
    }

    // Type text via Input domain — native keystrokes
    if (value) {
      await this.send(tabId, "Input.insertText", { text: value });
    }

    // Trigger change event
    await this.send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = window.__ocxRefs.get('${ref}');
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
    // Small delay for JS frameworks to render
    await new Promise(r => setTimeout(r, 600));

    return { ok: true, url };
  }

  /** Scroll via CDP Input.dispatchMouseEvent mouseWheel. */
  async scroll(tabId, { ref, to, dy } = {}) {
    if (ref) {
      // Scroll element into view via JS, then return page info
      await this.send(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__ocxRefs?.get('${ref}');
          if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
        })()`,
        returnByValue: true,
      });
      return this.getPageInfo(tabId);
    }

    if (to === "top") {
      await this.send(tabId, "Runtime.evaluate", {
        expression: "scrollTo({ top: 0 })",
        returnByValue: true,
      });
      await new Promise(r => setTimeout(r, 200));
      return this.getPageInfo(tabId);
    }

    if (to === "bottom") {
      // Progressive scroll like content script
      for (let i = 0; i < 30; i++) {
        await this.send(tabId, "Runtime.evaluate", {
          expression: "scrollBy({ top: innerHeight * 0.5 })",
          returnByValue: true,
        });
        await new Promise(r => setTimeout(r, 300));
        const info = await this.getPageInfo(tabId);
        if (info.ok && info.scrollPct >= 98) break;
      }
      return this.getPageInfo(tabId);
    }

    // Mouse wheel scroll
    const scrollAmount = dy ?? 600;
    await this.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 500, y: 400,
      deltaX: 0, deltaY: scrollAmount,
    });
    await new Promise(r => setTimeout(r, 200));
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
        if (!window.__ocxRefs) return { ok: false, error: 'No refs' };
        const el = window.__ocxRefs.get('${ref}');
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
        if (!window.__ocxRefs) return { ok: false, error: 'No refs — take a snapshot first.' };
        const q = String(${JSON.stringify(query)}).toLowerCase();
        if (!q) return { ok: false, error: 'Provide text to search for.' };
        const results = [];
        for (const [ref, el] of window.__ocxRefs) {
          if (!el.isConnected) continue;
          const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').toLowerCase();
          if (name.includes(q)) {
            const tag = el.tagName.toLowerCase();
            const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
            results.push(ref + ' | ' + tag + (aria ? ' "' + aria.slice(0, 60) + '"' : ''));
            if (results.length >= ${max}) break;
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
}

// Handle debugger detach events (user closes tab, opens DevTools, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  // The CDPController instance in background.js will clean up
  // We emit a custom event so tools.js can react
  chrome.runtime.sendMessage?.({ __ocx: true, cmd: "cdp-detach", tabId: source.tabId, reason }).catch(() => {});
});
