// content/accessibility-tree.js
// Claude-style accessibility tree generator.
// Registers window.__generateAccessibilityTree() that produces a text representation
// of the page's accessibility tree with element refs for interaction.
//
// Registered in MAIN world so CDP Runtime.evaluate can call it directly.
// Also registered in ISOLATED world (default) so content.js can call it.
// Each world maintains independent ref maps — never mixed.

(() => {
  if (window.__ocxTreeInstalled) return;
  window.__ocxTreeInstalled = true;

  // ---------- ref maps ----------
  if (!window.__ocxElementMap) window.__ocxElementMap = {};
  if (!window.__ocxElementReverseMap) window.__ocxElementReverseMap = new WeakMap();
  if (!window.__ocxRefCounter) window.__ocxRefCounter = 0;

  // ---------- role detection ----------
  function getRole(el) {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const roleMap = {
      a: 'link',
      button: 'button',
      input: ['submit', 'button', 'reset', 'image'].includes(type) ? 'button'
            : type === 'checkbox' ? 'checkbox'
            : type === 'radio' ? 'radio'
            : type === 'file' ? 'button'
            : 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading',
      img: 'image',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      section: 'region',
      article: 'article',
      aside: 'complementary',
      form: 'form',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      label: 'label',
      summary: 'button',
      details: 'group',
    };
    return roleMap[tag] || 'generic';
  }

  // ---------- sensitive field detection ----------
  function isSensitiveField(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const sensitive = [
      'current-password', 'new-password', 'one-time-code',
      'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
    ];
    return sensitive.some(s => autocomplete.includes(s));
  }

  // ---------- label extraction ----------
  function getLabel(el) {
    const tag = el.tagName.toLowerCase();

    // <select> — show selected option
    if (tag === 'select') {
      if (isSensitiveField(el)) {
        const aria = el.getAttribute('aria-label');
        if (aria?.trim()) return aria.trim();
        const title = el.getAttribute('title');
        if (title?.trim()) return title.trim();
        return '[value redacted]';
      }
      const selected = el.querySelector('option[selected]') || el.options[el.selectedIndex];
      if (selected?.textContent) return selected.textContent.trim();
    }

    // aria-label
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    // placeholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();

    // title
    const title = el.getAttribute('title');
    if (title?.trim()) return title.trim();

    // alt (for images)
    const alt = el.getAttribute('alt');
    if (alt?.trim()) return alt.trim();

    // <label for="id">
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) {
        const t = getDirectText(labelEl);
        if (t) return t;
      }
    }

    // Input value
    if (tag === 'input') {
      const type = el.getAttribute('type') || '';
      const value = el.getAttribute('value');
      if (type === 'submit' && value?.trim()) return value.trim();
      if (isSensitiveField(el)) return el.value ? '[value redacted]' : '';
      if (el.value && el.value.length < 50 && el.value.trim()) return el.value.trim();
    }

    if (tag === 'textarea' && isSensitiveField(el)) {
      return el.value ? '[value redacted]' : '';
    }

    // Direct text of button/a/summary
    if (['button', 'a', 'summary'].includes(tag)) {
      const t = getDirectText(el);
      if (t) return t;
    }

    // Heading text
    if (tag.match(/^h[1-6]$/)) {
      const text = el.textContent;
      if (text?.trim()) return text.trim().substring(0, 100);
    }

    // Fallback: direct text content
    const directText = getDirectText(el);
    if (directText && directText.length >= 3) {
      const trimmed = directText.trim();
      return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
    }

    return '';
  }

  function getDirectText(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    return text.trim();
  }

  // ---------- visibility / interactivity ----------
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && el.offsetWidth > 0
      && el.offsetHeight > 0;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag)) return true;
    if (el.getAttribute('onclick') !== null) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    const role = el.getAttribute('role');
    if (['button', 'link', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'searchbox', 'textbox', 'slider'].includes(role)) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function isStructural(el) {
    const tag = el.tagName.toLowerCase();
    return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside'].includes(tag)
      || el.getAttribute('role') !== null;
  }

  // ---------- element filtering ----------
  function shouldInclude(el, opts) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag)) return false;

    if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (opts.filter !== 'all' && !isVisible(el)) return false;

    if (opts.filter !== 'all' && !opts.refId) {
      // Viewport filter (unless looking for a specific ref)
      const rect = el.getBoundingClientRect();
      if (!(rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0)) return false;
    }

    if (opts.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el)) return true;
    if (isStructural(el)) return true;
    if (getLabel(el).length > 0) return true;
    const role = getRole(el);
    return role !== null && role !== 'generic' && role !== 'image';
  }

  // ---------- tree builder ----------
  function buildTree(el, depth, maxDepth, opts, lines, maxElements, counter) {
    if (counter.count >= maxElements) return;
    if (depth > maxDepth) return;
    if (!el || !el.tagName) return;

    const include = shouldInclude(el, opts) || (opts.refId !== null && depth === 0);
    if (include) {
      const role = getRole(el);
      const label = getLabel(el);

      // Get or create ref
      let refId = window.__ocxElementReverseMap.get(el);
      if (refId) {
        // Verify WeakRef is still valid
        const existing = window.__ocxElementMap[refId];
        if (!existing || existing.deref() !== el) refId = null;
      }
      if (!refId) {
        refId = 'ref_' + (++window.__ocxRefCounter);
        window.__ocxElementMap[refId] = new WeakRef(el);
        window.__ocxElementReverseMap.set(el, refId);
      }

      counter.count++;
      let line = '  '.repeat(depth) + role;
      if (label) {
        const cleanLabel = label.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"');
        line += ' "' + cleanLabel + '"';
      }
      line += ' [' + refId + ']';

      // Extra attributes
      const href = el.getAttribute('href');
      if (href) line += ' href="' + href + '"';
      const type = el.getAttribute('type');
      if (type) line += ' type="' + type + '"';
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) line += ' placeholder="' + placeholder + '"';

      // <select> options
      if (el.tagName.toLowerCase() === 'select' && !isSensitiveField(el)) {
        for (const option of el.options) {
          const optText = option.textContent ? option.textContent.trim() : '';
          if (optText) {
            let optLine = '  '.repeat(depth + 1) + 'option "' + optText.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"') + '"';
            if (option.selected) optLine += ' (selected)';
            if (option.value && option.value !== optText) optLine += ' value="' + option.value.replace(/"/g, '\\"') + '"';
            lines.push(optLine);
          }
        }
      }

      lines.push(line);
    }

    // Recurse into children (skip <select> children since we handled options above)
    if (el.tagName.toLowerCase() === 'select' && isSensitiveField(el)) return;
    if (el.children && depth < maxDepth) {
      for (const child of el.children) {
        buildTree(child, include ? depth + 1 : depth, maxDepth, opts, lines, maxElements, counter);
      }
    }
  }

  // ---------- public API ----------
  /**
   * Generate accessibility tree for the page.
   * @param {string} filter - 'all' (everything), 'interactive' (clickable elements only)
   * @param {number} maxDepth - maximum tree depth (default 15)
   * @param {number} maxChars - maximum output characters (default 50000)
   * @param {string} refId - if provided, generate tree for this specific element only
   * @returns {{ pageContent: string, viewport: {width: number, height: number}, error?: string }}
   */
  window.__generateAccessibilityTree = function(filter, maxDepth, maxChars, refId) {
    try {
      const lines = [];
      const depthLimit = maxDepth != null ? maxDepth : 15;
      const elementLimit = 10000;
      const charLimit = maxChars != null ? maxChars : 50000;
      const counter = { count: 0 };

      const opts = {
        filter: filter || 'all',
        refId: refId || null,
      };

      if (refId) {
        // Focus on specific element
        const ref = window.__ocxElementMap[refId];
        if (!ref) {
          return {
            error: "Element with ref_id '" + refId + "' not found. Use read_page without ref_id to get the current page state.",
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        const el = ref.deref();
        if (!el) {
          return {
            error: "Element with ref_id '" + refId + "' no longer exists. Use read_page without ref_id to get the current page state.",
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        buildTree(el, 0, depthLimit, opts, lines, elementLimit, counter);
      } else {
        // Full page tree
        if (document.body) {
          buildTree(document.body, 0, depthLimit, opts, lines, elementLimit, counter);
        }
      }

      // Clean up dead WeakRefs
      for (const key in window.__ocxElementMap) {
        if (!window.__ocxElementMap[key].deref()) {
          delete window.__ocxElementMap[key];
        }
      }

      let output = lines.join('\n');

      // Truncation
      if (counter.count >= elementLimit) {
        output += '\n[truncated at ' + elementLimit + ' elements — page is very large]';
      }
      if (maxChars != null && output.length > maxChars) {
        const totalLen = output.length;
        const breakPoint = output.lastIndexOf('\n', maxChars);
        const cutAt = breakPoint > 0 ? breakPoint : Math.max(0, maxChars);
        output = output.slice(0, cutAt)
          + '\n[output truncated at ' + maxChars + ' of ' + totalLen + ' characters]';
      }

      return {
        pageContent: output,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    } catch (e) {
      throw new Error('Error generating accessibility tree: ' + (e.message || 'Unknown error'));
    }
  };
})();
