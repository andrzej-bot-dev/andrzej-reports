// content/visual-indicator.js
// Visual feedback when the agent is active: phantom cursor, glow border,
// stop button, and static "active in tab group" pill.
//
// Adapted from Claude's agent-visual-indicator.js with Andrzej branding.
// Runs in ISOLATED world (needs chrome.runtime for stop button).

(() => {
  if (window.__ocxIndicatorInstalled) return;
  window.__ocxIndicatorInstalled = true;

  // State
  let glowBorder = null;       // outer glow div
  let phantomCursor = null;    // phantom cursor container
  let phantomStyled = null;    // styled SVG variant
  let stopContainer = null;    // stop button container
  let staticPill = null;       // "active in tab group" pill
  let audioCtx = null;         // AudioContext for user gesture unlock
  let agentActive = false;     // is agent currently driving?
  let staticMode = false;      // is static indicator showing?
  let heartbeatInterval = null;
  let hideForToolUse = false;
  let hideStaticForToolUse = false;
  let lastCursorX = null;
  let lastCursorY = null;

  // Brand color
  const BRAND = '#e8654f';
  const BRAND_GLOW = 'rgba(232, 101, 79, ';
  const BRAND_BG = '#1a1a2e';
  const BRAND_TEXT = '#ffffff';

  // ---------- styles ----------
  function injectStyles() {
    if (document.getElementById('ocx-indicator-styles')) return;
    const style = document.createElement('style');
    style.id = 'ocx-indicator-styles';
    style.textContent = `
      @keyframes ocx-pulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      #ocx-glow-border-inner {
        animation: ocx-pulse 2s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        #ocx-glow-border-inner { animation: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- phantom cursor ----------
  function createPhantomCursor(x, y) {
    const ns = 'http://www.w3.org/2000/svg';
    const cursor = document.createElement('div');
    cursor.id = 'ocx-phantom-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = `
      position: fixed; top: 0; left: 0;
      pointer-events: none; z-index: 2147483646;
      transform: translate3d(${x}px, ${y}px, 0);
      transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
      will-change: transform;
    `;

    // Pointer SVG path
    const path = 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z';

    // White outline variant (for dark backgrounds)
    const white = document.createElementNS(ns, 'svg');
    white.id = 'ocx-cursor-plain';
    white.setAttribute('width', '20');
    white.setAttribute('height', '26');
    white.setAttribute('viewBox', '0 0 20 26');
    white.style.cssText = 'position:absolute; top:0; left:0; overflow:visible;';
    const whitePath1 = document.createElementNS(ns, 'path');
    whitePath1.setAttribute('d', path);
    whitePath1.setAttribute('stroke', 'white');
    whitePath1.setAttribute('stroke-width', '3');
    whitePath1.setAttribute('stroke-linejoin', 'round');
    whitePath1.setAttribute('fill', 'white');
    const whitePath2 = document.createElementNS(ns, 'path');
    whitePath2.setAttribute('d', path);
    whitePath2.setAttribute('fill', '#111');
    white.appendChild(whitePath1);
    white.appendChild(whitePath2);

    // Styled variant (brand orange, with glow)
    phantomStyled = document.createElementNS(ns, 'svg');
    phantomStyled.id = 'ocx-cursor-styled';
    phantomStyled.setAttribute('width', '20');
    phantomStyled.setAttribute('height', '26');
    phantomStyled.setAttribute('viewBox', '0 0 20 26');
    phantomStyled.style.cssText = 'position:absolute; top:0; left:0; overflow:visible; filter: drop-shadow(0 0 4px ' + BRAND_GLOW + '0.9)) drop-shadow(0 0 10px ' + BRAND_GLOW + '0.45));';
    const styledPath1 = document.createElementNS(ns, 'path');
    styledPath1.setAttribute('d', path);
    styledPath1.setAttribute('stroke', BRAND);
    styledPath1.setAttribute('stroke-width', '3');
    styledPath1.setAttribute('stroke-linejoin', 'round');
    styledPath1.setAttribute('fill', BRAND);
    const styledPath2 = document.createElementNS(ns, 'path');
    styledPath2.setAttribute('d', path);
    styledPath2.setAttribute('fill', '#FAF9F5');
    phantomStyled.appendChild(styledPath1);
    phantomStyled.appendChild(styledPath2);

    cursor.appendChild(white);
    cursor.appendChild(phantomStyled);
    return cursor;
  }

  function movePhantomCursor(x, y) {
    lastCursorX = x;
    lastCursorY = y;
    if (!agentActive) return Promise.resolve();
    if (!phantomCursor) {
      if (document.hidden) return Promise.resolve();
      phantomCursor = createPhantomCursor(x, y);
      document.body.appendChild(phantomCursor);
      return Promise.resolve();
    }
    phantomCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (document.hidden) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          phantomCursor?.removeEventListener('transitionend', finish);
          resolve();
        }
      };
      phantomCursor.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 220);
    });
  }

  function removePhantomCursor() {
    if (phantomCursor?.parentNode) {
      phantomCursor.parentNode.removeChild(phantomCursor);
    }
    phantomCursor = null;
    phantomStyled = null;
  }

  // ---------- glow border ----------
  function showGlowBorder() {
    injectStyles();
    if (glowBorder) {
      glowBorder.style.display = '';
    } else {
      glowBorder = document.createElement('div');
      glowBorder.id = 'ocx-glow-border';
      glowBorder.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none; z-index: 2147483646;
        opacity: 0; transition: opacity 0.3s ease-in-out;
      `;
      const inner = document.createElement('div');
      inner.id = 'ocx-glow-border-inner';
      inner.style.cssText = `
        position: absolute; inset: 0; will-change: opacity;
        box-shadow:
          inset 0 0 15px ${BRAND_GLOW}0.7),
          inset 0 0 25px ${BRAND_GLOW}0.5),
          inset 0 0 35px ${BRAND_GLOW}0.2);
      `;
      glowBorder.appendChild(inner);
      document.body.appendChild(glowBorder);
    }
    requestAnimationFrame(() => {
      if (glowBorder) glowBorder.style.opacity = '1';
    });
  }

  function hideGlowBorder() {
    if (!agentActive && !staticMode && glowBorder) {
      glowBorder.style.opacity = '0';
      setTimeout(() => {
        if (!agentActive && !staticMode && glowBorder?.parentNode) {
          glowBorder.parentNode.removeChild(glowBorder);
          glowBorder = null;
        }
      }, 300);
    }
  }

  // ---------- stop button ----------
  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'ocx-stop-container';
    container.style.cssText = `
      position: fixed; bottom: 16px; left: 50%;
      transform: translateX(-50%);
      display: flex; justify-content: center; align-items: center;
      pointer-events: none; z-index: 2147483647;
    `;
    const btn = document.createElement('button');
    btn.id = 'ocx-stop-button';
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="margin-right: 12px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
      </svg>
      <span style="vertical-align: middle;">Stop Andrzej</span>
    `;
    btn.style.cssText = `
      position: relative; transform: translateY(100px);
      padding: 12px 16px; background: ${BRAND_BG}; color: ${BRAND_TEXT};
      border: 0.5px solid rgba(255, 255, 255, 0.2); border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px; font-weight: 600; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      box-shadow: 0 40px 80px ${BRAND_GLOW}0.24), 0 4px 14px ${BRAND_GLOW}0.24);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0; user-select: none; pointer-events: auto;
      white-space: nowrap; margin: 0 auto;
    `;
    btn.addEventListener('mouseenter', () => {
      if (agentActive) btn.style.background = '#2a2a3e';
    });
    btn.addEventListener('mouseleave', () => {
      if (agentActive) btn.style.background = BRAND_BG;
    });
    btn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ __ocx: true, cmd: 'STOP_AGENT' });
      } catch { /* ignore */ }
    });
    container.appendChild(btn);
    return container;
  }

  function showAgentUI() {
    showGlowBorder();
    if (!stopContainer) {
      stopContainer = createStopButton();
      document.body.appendChild(stopContainer);
    } else {
      stopContainer.style.display = '';
    }
    // Show phantom cursor at center if not yet positioned
    if (!phantomCursor && lastCursorX == null) {
      lastCursorX = Math.round(window.innerWidth / 2);
      lastCursorY = Math.round(window.innerHeight / 2);
    }
    if (phantomStyled) phantomStyled.style.display = '';
    requestAnimationFrame(() => {
      const btn = stopContainer?.querySelector('#ocx-stop-button');
      if (btn) {
        btn.style.transform = 'translateY(0)';
        btn.style.opacity = '1';
      }
    });
  }

  function hideAgentUI() {
    agentActive = false;
    hideGlowBorder();
    if (audioCtx?.suspend) audioCtx.suspend().catch(() => {});
    if (staticMode) {
      // Static mode: just hide stop button and cursor
      if (stopContainer?.parentNode) {
        stopContainer.parentNode.removeChild(stopContainer);
        stopContainer = null;
      }
      removePhantomCursor();
      return;
    }
    // Animate out stop button
    if (stopContainer) {
      const btn = stopContainer.querySelector('#ocx-stop-button');
      if (btn) {
        btn.style.transform = 'translateY(100px)';
        btn.style.opacity = '0';
      }
      setTimeout(() => {
        if (!agentActive && stopContainer?.parentNode) {
          stopContainer.parentNode.removeChild(stopContainer);
          stopContainer = null;
        }
      }, 300);
    }
    setTimeout(() => {
      if (!agentActive) removePhantomCursor();
    }, 300);
  }

  // ---------- static pill ("active in tab group") ----------
  function createStaticPill() {
    const pill = document.createElement('div');
    pill.id = 'ocx-static-indicator';
    pill.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"
           style="width:16px;height:16px;display:inline-block;vertical-align:middle;flex-shrink:0;margin-right:8px;">
        <circle cx="8" cy="8" r="6" fill="${BRAND}" opacity="0.3">
          <animate attributeName="r" values="6;7;6" dur="2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.3;0.6;0.3" dur="2s" repeatCount="indefinite"/>
        </circle>
        <circle cx="8" cy="8" r="3" fill="${BRAND}"/>
      </svg>
      <span style="vertical-align:middle;color:${BRAND_TEXT};font-size:14px;display:inline-block;">
        Andrzej is active in this tab group
      </span>
      <div style="display:inline-block;width:0.5px;height:32px;background:rgba(255,255,255,0.15);margin:0 8px;vertical-align:middle;"></div>
      <button id="ocx-static-close" style="position:relative;display:inline-flex;align-items:center;justify-content:center;padding:6px;background:transparent;border:none;cursor:pointer;pointer-events:auto;vertical-align:middle;width:32px;height:32px;border-radius:8px;transition:background 0.2s;">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;display:block;">
          <path d="M15 5L5 15M5 5l10 10" stroke="${BRAND_TEXT}" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    pill.style.cssText = `
      position: fixed; bottom: 16px; left: 50%;
      transform: translateX(-50%);
      display: inline-flex; align-items: center; justify-content: center;
      padding: 6px 6px 6px 16px; background: ${BRAND_BG};
      border: 0.5px solid rgba(255, 255, 255, 0.15); border-radius: 14px;
      box-shadow: 0 40px 80px 0 rgba(0, 0, 0, 0.25);
      z-index: 2147483647; pointer-events: none;
      white-space: nowrap; user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;
    const closeBtn = pill.querySelector('#ocx-static-close');
    if (closeBtn) {
      closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'rgba(255,255,255,0.1)'; });
      closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; });
      closeBtn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ __ocx: true, cmd: 'DISMISS_STATIC_INDICATOR' });
        } catch { /* ignore */ }
        hideStaticPill();
      });
    }
    return pill;
  }

  function showStaticPill() {
    staticMode = true;
    showGlowBorder();
    if (!staticPill) {
      staticPill = createStaticPill();
      document.body.appendChild(staticPill);
    } else {
      staticPill.style.display = '';
    }
    // Start heartbeat
    if (!heartbeatInterval) {
      heartbeatInterval = setInterval(async () => {
        try {
          const resp = await chrome.runtime.sendMessage({ __ocx: true, cmd: 'STATIC_HEARTBEAT' });
          if (!resp?.ok) hideStaticPill();
        } catch {
          hideStaticPill();
        }
      }, 5000);
    }
  }

  function hideStaticPill() {
    staticMode = false;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (staticPill?.parentNode) {
      staticPill.parentNode.removeChild(staticPill);
      staticPill = null;
    }
    hideGlowBorder();
  }

  // ---------- visibility change handler ----------
  function onVisibilityChange() {
    if (document.hidden) return;
    if (hideForToolUse || hideStaticForToolUse) return;
    if (agentActive) showAgentUI();
    if (staticMode) showStaticPill();
  }

  // ---------- message handler ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__ocx !== true) return false;

    switch (msg.cmd) {
      case 'SHOW_INDICATORS':
        agentActive = true;
        // Unlock audio on user gesture
        try {
          if (!audioCtx) {
            audioCtx = new AudioContext();
            const gain = audioCtx.createGain();
            gain.gain.value = 0;
            gain.connect(audioCtx.destination);
            const src = audioCtx.createConstantSource();
            src.connect(gain);
            src.start();
          }
          audioCtx.resume().catch(() => {});
        } catch { /* ignore */ }
        if (!document.hidden) showAgentUI();
        sendResponse({ ok: true });
        return false;

      case 'HIDE_INDICATORS':
        hideAgentUI();
        sendResponse({ ok: true });
        return false;

      case 'UPDATE_CURSOR':
        if (msg.x != null && msg.y != null) {
          movePhantomCursor(msg.x, msg.y).then(() => sendResponse({ ok: true }));
          return true; // async
        }
        sendResponse({ ok: true });
        return false;

      case 'SHOW_PILL':
        showStaticPill();
        sendResponse({ ok: true });
        return false;

      case 'HIDE_PILL':
        hideStaticPill();
        sendResponse({ ok: true });
        return false;

      case 'HIDE_FOR_TOOL_USE':
        hideForToolUse = agentActive;
        hideStaticForToolUse = staticMode;
        if (glowBorder) glowBorder.style.display = 'none';
        if (stopContainer) stopContainer.style.display = 'none';
        if (phantomStyled) phantomStyled.style.display = 'none';
        if (staticPill && staticMode) staticPill.style.display = 'none';
        sendResponse({ ok: true });
        return false;

      case 'SHOW_AFTER_TOOL_USE':
        if (hideForToolUse && glowBorder) glowBorder.style.display = '';
        if (hideForToolUse && stopContainer) stopContainer.style.display = '';
        if (phantomStyled) phantomStyled.style.display = '';
        if (hideStaticForToolUse && staticPill) staticPill.style.display = '';
        hideForToolUse = false;
        hideStaticForToolUse = false;
        onVisibilityChange();
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });

  document.addEventListener('visibilitychange', onVisibilityChange);

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    hideAgentUI();
    hideStaticPill();
    removePhantomCursor();
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  });
})();
