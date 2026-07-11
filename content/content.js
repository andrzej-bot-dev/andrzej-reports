// Content script: performs actions on the page on behalf of the side panel.
// Maintains a registry of references (e1, e2, ...) to interactive elements,
// returns a concise page "snapshot" for the agent and executes actions
// (click, typing, scroll, option selection) with visual highlighting.

(() => {
  if (window.__ocxInstalled) return;
  window.__ocxInstalled = true;

  // ---------- GLOBAL FOCUS GUARD (runs at document_start) ----------
  // Prevent target="_blank" from stealing focus when agent clicks links.
  // This runs BEFORE any page scripts, catching all <a> elements and window.open().
  if (!window.__ocxFocusGuard) {
    window.__ocxFocusGuard = true;

    // Intercept window.open — replace _blank with _self
    const _origOpen = window.open;
    window.open = function(url, name, features) {
      if (name === '_blank' || !name) name = '_self';
      return _origOpen.call(window, url, name, features);
    };

    // Strip target="_blank" from all existing and future links
    const stripBlank = (el) => {
      if (!el) return;
      if (el.tagName === 'A' && el.target === '_blank') el.target = '_self';
      el.querySelectorAll?.('a[target="_blank"]')?.forEach(a => a.target = '_self');
    };
    // Process existing DOM — documentElement may not exist yet at document_start
    const docEl = document.documentElement;
    if (docEl) stripBlank(docEl);
    document.addEventListener('DOMContentLoaded', () => {
      if (document.documentElement) stripBlank(document.documentElement);
    }, { once: true });

    // Watch for dynamically added links
    new MutationObserver(muts => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'A' && n.target === '_blank') n.target = '_self';
          n.querySelectorAll?.('a[target="_blank"]')?.forEach(a => a.target = '_self');
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- reference registry ----------
  let refToEl = new Map();   // "e12" -> Element
  let elToRef = new WeakMap();
  let refCounter = 0;
  let snapshotGen = 0;

  function refFor(el) {
    let ref = elToRef.get(el);
    if (!ref) {
      ref = "e" + (++refCounter);
      elToRef.set(el, ref);
    }
    refToEl.set(ref, el);
    return ref;
  }

  function resolveTarget({ ref, selector }) {
    if (ref) {
      // Try our local refToEl map first
      let el = refToEl.get(ref);
      if (el && el.isConnected) return el;
      // Try accessibility tree's ref map (ref_N format)
      if (window.__ocxElementMap && ref.startsWith('ref_')) {
        const weakRef = window.__ocxElementMap[ref];
        if (weakRef) {
          el = weakRef.deref();
          if (el && el.isConnected) {
            refToEl.set(ref, el);
            elToRef.set(el, ref);
            return el;
          }
        }
      }
      return null;
    }
    if (selector) {
      try { return document.querySelector(selector); } catch { return null; }
    }
    return null;
  }

  // ---------- helpers ----------
  const INTERACTIVE_SEL = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
    "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=combobox]",
    "[role=option]", "[role=searchbox]", "[role=textbox]",
    "[contenteditable=true]", "[contenteditable=plaintext-only]", "[onclick]", "[tabindex]"
  ].join(",");

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) return false;
    return true;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function clean(s, max = 90) {
    if (!s) return "";
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return t;
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent?.trim()) return lab.textContent;
    }
    const closestLabel = el.closest("label");
    if (closestLabel?.textContent?.trim()) return closestLabel.textContent;
    return el.getAttribute("placeholder") || el.getAttribute("title") ||
           el.getAttribute("alt") || el.textContent || el.getAttribute("name") || "";
  }

  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    let kind = tag;
    if (tag === "input") kind = `input[${type || "text"}]`;
    else if (role) kind = `${tag}(${role})`;
    let desc = `${kind}`;
    const name = clean(accName(el));
    if (name) desc += ` "${name}"`;
    return desc;
  }

  // ---------- snapshot (Claude-style accessibility tree) ----------
  function snapshot({ maxChars = 50000, viewportOnly = true, filter = 'interactive', refId = null } = {}) {
    snapshotGen++;
    refToEl = new Map(); // old refs cleared

    // Use __generateAccessibilityTree if available (injected by accessibility-tree.js)
    if (typeof window.__generateAccessibilityTree === 'function') {
      try {
        const result = window.__generateAccessibilityTree(
          viewportOnly ? filter : 'all',
          15,           // maxDepth
          maxChars,     // maxChars
          refId         // refId (for focused tree on specific element)
        );
        if (result.error) {
          return { ok: false, error: result.error };
        }

        // Build refToEl map from the accessibility tree's refs so actions resolve
        // The accessibility tree uses ref_N format, we need to map these to actual elements
        // The __ocxElementMap in the accessibility tree's world has WeakRefs
        // Since content.js runs in the same isolated world, it can access them
        if (window.__ocxElementMap) {
          for (const [refId, weakRef] of Object.entries(window.__ocxElementMap)) {
            const el = weakRef.deref();
            if (el && el.isConnected) {
              refToEl.set(refId, el);
              elToRef.set(el, refId);
            }
          }
        }

        const header = [
          `URL: ${location.href}`,
          `TITLE: ${clean(document.title, 200)}`,
        ];
        const scrollPct = document.documentElement.scrollHeight <= innerHeight ? 100 :
          Math.round((scrollY + innerHeight) / document.documentElement.scrollHeight * 100);
        header.push(`VIEWPORT: scrolled to ${scrollPct}% (scrollY=${Math.round(scrollY)}, pageHeight=${document.documentElement.scrollHeight})`);
        header.push('');

        const fullSnapshot = header.join('\n') + result.pageContent;
        return { ok: true, snapshot: fullSnapshot, gen: snapshotGen };
      } catch (e) {
        // Fall through to legacy snapshot
        console.warn('[OCX] Accessibility tree failed, falling back to legacy:', e.message);
      }
    }

    // ---------- legacy snapshot (fallback) ----------
    const lines = [];
    const push = (s) => lines.push(s);

    push(`URL: ${location.href}`);
    push(`TITLE: ${clean(document.title, 200)}`);
    push("");
    push("ELEMENTS (ref | element | state):");

    const seen = new Set();
    const all = document.querySelectorAll(`h1, h2, h3, ${INTERACTIVE_SEL}`);
    let count = 0;
    for (const el of all) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      if (viewportOnly && !inViewport(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (/^h[1-3]$/.test(tag)) {
        const t = clean(el.textContent, 120);
        if (t) push(`── ${tag.toUpperCase()}: ${t}`);
        continue;
      }

      if (!el.matches(INTERACTIVE_SEL)) continue;
      if (tag === "div" || tag === "span") {
        const role = el.getAttribute("role");
        const editable = el.isContentEditable;
        const clickable = el.hasAttribute("onclick") || role;
        if (!editable && !clickable) continue;
      }

      const ref = refFor(el);
      let line = `${ref} | ${describeEl(el)}`;

      const states = [];
      if (el.disabled) states.push("disabled");
      if (el.checked) states.push("checked");
      if (el.selected) states.push("selected");
      if (el.getAttribute("aria-expanded")) states.push(`expanded=${el.getAttribute("aria-expanded")}`);
      if (tag === "input" || tag === "textarea") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "password") states.push("value=•••");
        else if (el.value) states.push(`value="${clean(el.value, 60)}"`);
      }
      if (el.isContentEditable && el.textContent.trim()) states.push(`text="${clean(el.textContent, 60)}"`);
      if (tag === "select") {
        const opts = [...el.options].slice(0, 12).map(o => (o.selected ? "*" : "") + clean(o.textContent, 30));
        states.push(`options=[${opts.join(", ")}]${el.options.length > 12 ? "…" : ""}`);
      }
      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href && !href.startsWith("javascript:")) states.push(`href=${clean(href, 80)}`);
      }
      if (!inViewport(el)) states.push("off-screen");
      if (states.length) line += ` | ${states.join(", ")}`;
      push(line);

      if (++count > 500) { push(`… (element list truncated, there were more)`); break; }
      if (lines.join("\n").length > maxChars) { push("… (truncated — page has too many elements)"); break; }
    }

    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (truncated)";
    return { ok: true, snapshot: out, gen: snapshotGen };
  }

  function getText({ maxChars = 20000 } = {}) {
    let text = document.body?.innerText || "";
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars) + "\n… (truncated)";
    return { ok: true, url: location.href, title: document.title, text, truncated };
  }

  function pageInfo() {
    return {
      ok: true,
      url: location.href,
      title: document.title,
      scrollY: Math.round(scrollY),
      pageHeight: document.documentElement.scrollHeight,
      viewport: { w: innerWidth, h: innerHeight }
    };
  }

  // ---------- highlight / cursor ----------
  function flashHighlight(el, label = "") {
    try {
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = `
        position: fixed; z-index: 2147483647; pointer-events: none;
        left: ${r.left - 4}px; top: ${r.top - 4}px;
        width: ${r.width + 8}px; height: ${r.height + 8}px;
        border: 2px solid #e8654f; border-radius: 8px;
        box-shadow: 0 0 0 4px rgba(232,101,79,.25), 0 0 18px rgba(232,101,79,.5);
        transition: opacity .4s ease; opacity: 1;`;
      if (label) {
        const tag = document.createElement("div");
        tag.textContent = label;
        tag.style.cssText = `
          position: absolute; top: -26px; left: 0; background: #e8654f; color: #fff;
          font: 600 11px/1.6 -apple-system, system-ui, sans-serif; padding: 1px 8px;
          border-radius: 6px; white-space: nowrap;`;
        box.appendChild(tag);
      }
      document.documentElement.appendChild(box);
      setTimeout(() => { box.style.opacity = "0"; }, 700);
      setTimeout(() => box.remove(), 1200);
    } catch { /* ignore */ }
  }

  // ---------- actions ----------
  function firePointer(el, type, x, y) {
    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: type.includes("down") ? 1 : 0,
      pointerId: 1, isPrimary: true, pointerType: "mouse"
    };
    if (type.startsWith("pointer")) el.dispatchEvent(new PointerEvent(type, common));
    else el.dispatchEvent(new MouseEvent(type, common));
  }

  async function doClick({ ref, selector, dblclick = false }) {
    const el = resolveTarget({ ref, selector });
    if (!el) return { ok: false, error: `Element not found (${ref || selector}). Take a new snapshot.` };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await new Promise(r => setTimeout(r, 120));

    // Prevent target="_blank" from stealing focus — temporarily remove it
    // so the link opens in the same tab (or we handle it via background onCreated)
    const wasTargetBlank = el.tagName === 'A' && (el.target === '_blank' || el.getAttribute('target') === '_blank');
    const savedTarget = el.target;
    if (wasTargetBlank) {
      el.target = '_self';
    }
    // Also prevent window.open() calls from stealing focus
    const origOpen = window.open;
    window.open = function(url, name, features) {
      // Replace _blank with _self to keep focus
      if (name === '_blank' || !name) name = '_self';
      return origOpen.call(window, url, name, features);
    };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    flashHighlight(el, "click");

    // the element may be covered — click what's actually on top, if it's a descendant
    let target = el;
    const top = document.elementFromPoint(x, y);
    if (top && el.contains(top)) target = top;

    try {
      firePointer(target, "pointerover", x, y);
      firePointer(target, "mouseover", x, y);
      firePointer(target, "pointerdown", x, y);
      firePointer(target, "mousedown", x, y);
      target.focus?.({ preventScroll: true });
      firePointer(target, "pointerup", x, y);
      firePointer(target, "mouseup", x, y);
      firePointer(target, "click", x, y);
      if (dblclick) firePointer(target, "dblclick", x, y);
    } catch (e) {
      // Restore originals even on error
      if (wasTargetBlank) el.target = savedTarget;
      window.open = origOpen;
      return { ok: false, error: `Click failed: ${e.message}` };
    }

    // Restore originals after click
    if (wasTargetBlank) el.target = savedTarget;
    window.open = origOpen;

    return { ok: true, clicked: describeEl(el) };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  async function doFill({ ref, selector, value = "", clear = true, pressEnter = false }) {
    const el = resolveTarget({ ref, selector });
    if (!el) return { ok: false, error: `Element not found (${ref || selector}). Take a new snapshot.` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(r => setTimeout(r, 80));
    flashHighlight(el, "typing");
    el.focus?.({ preventScroll: true });

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (clear) setNativeValue(el, "");
      setNativeValue(el, clear ? value : el.value + value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (clear) {
        const sel = getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
        document.execCommand("delete", false);
      }
      document.execCommand("insertText", false, value);
    } else {
      return { ok: false, error: "This element is not a text field." };
    }

    if (pressEnter) {
      await new Promise(r => setTimeout(r, 60));
      pressKeyOn(el, "Enter");
    }
    return { ok: true, filled: describeEl(el), valueLength: value.length, pressedEnter: !!pressEnter };
  }

  const KEYMAP = {
    "enter": ["Enter", 13], "tab": ["Tab", 9], "escape": ["Escape", 27], "esc": ["Escape", 27],
    "backspace": ["Backspace", 8], "delete": ["Delete", 46], "space": [" ", 32],
    "arrowup": ["ArrowUp", 38], "arrowdown": ["ArrowDown", 40],
    "arrowleft": ["ArrowLeft", 37], "arrowright": ["ArrowRight", 39],
    "pageup": ["PageUp", 33], "pagedown": ["PageDown", 34],
    "home": ["Home", 36], "end": ["End", 35]
  };

  function pressKeyOn(el, keyName) {
    const norm = String(keyName || "").toLowerCase().replace(/\s/g, "");
    const [key, keyCode] = KEYMAP[norm] || [keyName, 0];
    const opts = { key, code: key === " " ? "Space" : key, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    // Enter in a form: if the page didn't handle the event, try submitting the form
    if (key === "Enter" && (el instanceof HTMLInputElement) && el.form) {
      const form = el.form;
      setTimeout(() => {
        if (document.contains(form)) form.requestSubmit?.();
      }, 150);
    }
  }

  function doPress({ key, ref, selector }) {
    const el = resolveTarget({ ref, selector }) || document.activeElement || document.body;
    flashHighlight(el, key);
    pressKeyOn(el, key);
    return { ok: true, pressed: key, on: describeEl(el) };
  }

  function doSelect({ ref, selector, value, label }) {
    const el = resolveTarget({ ref, selector });
    if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "This is not a <select>." };
    let opt = null;
    if (value !== undefined) opt = [...el.options].find(o => o.value === String(value));
    if (!opt && label) opt = [...el.options].find(o => o.textContent.trim().toLowerCase().includes(String(label).toLowerCase()));
    if (!opt) return { ok: false, error: `Option not found (value=${value}, label=${label}). Available: ${[...el.options].map(o => o.textContent.trim()).slice(0, 20).join(" | ")}` };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    flashHighlight(el, "selected");
    return { ok: true, selected: clean(opt.textContent, 60) };
  }

  async function doScroll({ ref, selector, to, dy, maxSteps = 40, stepDelayMs = 800 }) {
    if (ref || selector) {
      const el = resolveTarget({ ref, selector });
      if (!el) return { ok: false, error: "Element not found for scrolling." };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      await new Promise(r => setTimeout(r, 250));
      return pageInfo();
    }
    if (to === "top") {
      scrollTo({ top: 0 });
      await new Promise(r => setTimeout(r, 250));
      return pageInfo();
    }
    if (to === "bottom") {
      // Progressive scroll: step down a viewport at a time so lazy-loaded /
      // virtualized content (e.g. a cart that fills in as you approach the end)
      // gets rendered. Keep going while the page grows; stop once the height is
      // stable at the bottom, or after maxSteps (guards against infinite feeds).
      let steps = 0, stableRounds = 0, lastHeight = -1;
      const pageHeight = () => document.documentElement.scrollHeight;
      const atBottom = () => scrollY + innerHeight >= pageHeight() - 2;
      while (steps < maxSteps) {
        if (atBottom() && pageHeight() === lastHeight) {
          if (++stableRounds >= 2) break; // no growth for two rounds → really done
        } else {
          stableRounds = 0;
        }
        lastHeight = pageHeight();
        scrollBy({ top: innerHeight * 0.5 });
        steps++;
        await new Promise(r => setTimeout(r, stepDelayMs));
      }
      return { ...pageInfo(), scrolledSteps: steps, reachedBottom: atBottom() };
    }
    scrollBy({ top: dy ?? innerHeight * 0.8 });
    await new Promise(r => setTimeout(r, 250));
    return pageInfo();
  }

  function doFind({ query, max = 15 }) {
    const q = String(query || "").toLowerCase();
    if (!q) return { ok: false, error: "Provide text to search for." };
    const results = [];
    for (const el of document.querySelectorAll(INTERACTIVE_SEL)) {
      if (!isVisible(el)) continue;
      const name = (accName(el) || "").toLowerCase();
      if (name.includes(q)) {
        results.push(`${refFor(el)} | ${describeEl(el)}${inViewport(el) ? "" : " | off-screen"}`);
        if (results.length >= max) break;
      }
    }
    return { ok: true, matches: results, count: results.length };
  }

  async function doWaitFor({ selector, text, timeoutMs = 8000 }) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (selector) {
        try { if (document.querySelector(selector)) return { ok: true, found: selector, waitedMs: Date.now() - t0 }; } catch {
          return { ok: false, error: "Invalid CSS selector." };
        }
      }
      if (text && document.body?.innerText?.toLowerCase().includes(String(text).toLowerCase())) {
        return { ok: true, found: `text: ${text}`, waitedMs: Date.now() - t0 };
      }
      if (!selector && !text) { await new Promise(r => setTimeout(r, Math.min(timeoutMs, 2000))); return { ok: true, waitedMs: Date.now() - t0 }; }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, error: `Timed out waiting for (${selector || text}) in ${timeoutMs}ms.` };
  }

  // ---------- edge glow / visual indicators (agent working) ----------
  function workingIndicator({ on }) {
    // Send to visual-indicator.js which manages full Claude-style indicators
    if (on) {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'SHOW_INDICATORS' }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'HIDE_INDICATORS' }).catch(() => {});
    }
    // Also keep the legacy glow as a fallback
    let glow = document.getElementById("__ocx_glow");
    if (on && !glow) {
      glow = document.createElement("div");
      glow.id = "__ocx_glow";
      glow.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
        box-shadow: inset 0 0 26px 6px rgba(232,101,79,.38);
        animation: __ocx_pulse 1.6s ease-in-out infinite;`;
      const style = document.createElement("style");
      style.id = "__ocx_glow_style";
      style.textContent = `@keyframes __ocx_pulse { 50% { opacity: .45; } }`;
      document.documentElement.append(style, glow);
    } else if (!on) {
      glow?.remove();
      document.getElementById("__ocx_glow_style")?.remove();
    }
    return { ok: true };
  }

  // ---------- eval_js ----------
  function evalJs({ code }) {
    if (!code) return { ok: false, error: "No code provided." };
    try {
      const result = new Function(code)();
      return { ok: true, result: result ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // ---------- hover ----------
  async function doHover({ ref, selector }) {
    const el = resolveTarget({ ref, selector });
    if (!el) return { ok: false, error: `Element not found (${ref || selector}). Take a new snapshot.` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(r => setTimeout(r, 80));
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    flashHighlight(el, "hover");
    return { ok: true, hovered: describeEl(el) };
  }

  // ---------- router ----------
  const HANDLERS = {
    ping: () => ({ ok: true, pong: true }),
    working_indicator: workingIndicator,
    snapshot: snapshot,
    get_text: getText,
    page_info: pageInfo,
    click: doClick,
    fill: doFill,
    press: doPress,
    select_option: doSelect,
    scroll: doScroll,
    find: doFind,
    wait_for: doWaitFor,
    eval_js: evalJs,
    hover: doHover,
    show_indicators: () => {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'SHOW_INDICATORS' }).catch(() => {});
      return workingIndicator({ on: true });
    },
    hide_indicators: () => {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'HIDE_INDICATORS' }).catch(() => {});
      return workingIndicator({ on: false });
    },
    update_cursor: ({ x, y }) => {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'UPDATE_CURSOR', x, y }).catch(() => {});
      return { ok: true };
    },
    show_pill: () => {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'SHOW_PILL' }).catch(() => {});
      return { ok: true };
    },
    hide_pill: () => {
      chrome.runtime.sendMessage({ __ocx: true, cmd: 'HIDE_PILL' }).catch(() => {});
      return { ok: true };
    },
    highlight: ({ ref, selector, label }) => {
      const el = resolveTarget({ ref, selector });
      if (!el) return { ok: false, error: "Element not found." };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      flashHighlight(el, label || "");
      return { ok: true };
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__ocx !== true) return false;
    const handler = HANDLERS[msg.cmd];
    if (!handler) { sendResponse({ ok: false, error: `Unknown command: ${msg.cmd}` }); return false; }
    Promise.resolve()
      .then(() => handler(msg.args || {}))
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // async response
  });
})();
