// Direct LLM client (direct mode — "without OpenClaw"): talks directly to a provider's API
// in OpenAI-compatible or Anthropic-compatible format. Maintains its own
// conversation history per session (APIs are stateless), streams responses (SSE)
// and exposes the same interface as OpenClawGateway, so the rest of the extension
// (controller, agent loop) works unchanged.

import { getPreset } from "./providers.js";
import { pruneEphemeralHistory, estimateMessagesTokens, estimateTokens } from "./agent/context.js";

export class DirectBackend extends EventTarget {
  constructor({ getSettings, debug }) {
    super();
    this.getSettings = getSettings;
    this.debug = debug || (() => {});
    this.kind = "direct";
    this.connected = true;               // no persistent connection — readiness checked per request
    this.supportsAttachments = true;
    this.histories = new Map();          // sessionKey -> [permanent messages]
    this.toolContexts = new Map();        // sessionKey -> [ephemeral tool messages (rebuilt each turn)]
    this.lastUsage = new Map();          // sessionKey -> {input, output, cacheRead, cacheWrite, at} from the last API response
    this._systemTokens = new Map();      // sessionKey -> estimated tokens of the last system message
    this.busy = new Set();
    this.aborts = new Map();             // sessionKey -> AbortController
    this.providerId = "";
    this.model = "";
  }

  setSelection(providerId, model) {
    this.providerId = providerId || "";
    this.model = model || "";
  }

  config() {
    const s = this.getSettings();
    const p = getPreset(this.providerId);
    if (!p) return null;
    const apiKey = (s.providerKeys?.[this.providerId] || "").trim();
    const baseUrl = (s.providerBaseUrls?.[this.providerId] || p.baseUrl).replace(/\/+$/, "");
    return {
      ...p, apiKey, baseUrl,
      model: this.model,
      maxTokens: Math.max(256, Number(s.directMaxTokens) || 8192),
    };
  }

  ready() { const c = this.config(); return !!(c && c.apiKey); }

  // ---- interface compatible with OpenClawGateway ----
  sessionMatches(key, other) { return !!key && key === other; }
  isBusy(sessionKey) { return this.busy.has(sessionKey); }
  resetSession(sessionKey) {
    this.histories.delete(sessionKey);
    this.toolContexts.delete(sessionKey);
    this.lastUsage.delete(sessionKey);
  }

  /** Clear tool context at the start of each agent turn. */
  resetTurn(sessionKey) {
    this.toolContexts.delete(sessionKey);
    // The last usage reading measured a context whose ephemeral part was just
    // dropped — keeping it would trigger a spurious compaction at step 0.
    this.lastUsage.delete(sessionKey);
  }

  /**
   * CONTEXT COMPACTION: drop the whole ephemeral tool context of the current
   * turn. The agent loop calls this when the context window is nearly full and
   * replaces the dropped history with a recap message it sends next.
   */
  compactTurn(sessionKey) {
    this.toolContexts.set(sessionKey, []);
    // The last usage reading described the pre-compaction context — drop it so
    // the loop doesn't keep seeing a stale "context full" figure and re-compact.
    this.lastUsage.delete(sessionKey);
  }

  /** Usage from the last API response (input/output/cache tokens), if any. */
  getLastUsage(sessionKey) { return this.lastUsage.get(sessionKey) || null; }

  /**
   * Best-effort size of the NEXT request's context in tokens: the maximum of a
   * chars/4 estimate over everything we'd send and the last real usage reading.
   */
  getContextTokens(sessionKey) {
    const est = estimateMessagesTokens([
      ...(this.histories.get(sessionKey) || []),
      ...(this.toolContexts.get(sessionKey) || []),
    ]) + (this._systemTokens.get(sessionKey) || 0);
    const u = this.lastUsage.get(sessionKey);
    const measured = u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
    return Math.max(est, measured);
  }

  /** Store a permanent message in history without making an LLM call. */
  storePermanent(sessionKey, role, text) {
    const h = this.histories.get(sessionKey) || [];
    h.push({ role, text, images: [] });
    this.histories.set(sessionKey, h);
  }

  ping() { return true; }
  makeSessionKey() {
    const r = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
    return `direct-${r}`;
  }
  close() {
    for (const a of this.aborts.values()) { try { a.abort("close"); } catch { /* ignore */ } }
    this.aborts.clear();
    this.busy.clear();
  }

  emitStatus() {
    const c = this.config();
    const ok = !!(c && c.apiKey);
    this.dispatchEvent(new CustomEvent("status", {
      detail: { state: ok ? "online" : "offline", reason: ok ? c.label : "Add a provider API key in settings." },
    }));
  }

  // ---- models ----
  async listModels() {
    const c = this.config();
    if (!c) return [];
    if (!c.apiKey) return [];
    try {
      const live = c.format === "anthropic" ? await this._listAnthropic(c) : await this._listOpenAI(c);
      if (live.length) return live;
    } catch (e) { this.debug("×", `models.list(${c.id}): ${e.message}`); }
    return []; // no hardcoded fallback — models must come from the API
  }

  async _listOpenAI(c) {
    const res = await fetch(`${c.baseUrl}/models`, { headers: this._openaiHeaders(c) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arr = data?.data || data?.models || (Array.isArray(data) ? data : []);
    return arr
      .map((m) => ({ id: String(m.id || m.name || m).replace(/^models\//, "") }))
      .filter((m) => m.id);
  }

  async _listAnthropic(c) {
    const res = await fetch(`${c.baseUrl}/v1/models`, { headers: this._anthropicHeaders(c) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }

  _openaiHeaders(c) {
    return { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` };
  }
  _anthropicHeaders(c) {
    return {
      "content-type": "application/json",
      "x-api-key": c.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  // ---- chat ----
  async sendAndWaitFinal({ sessionKey, text, attachments = [], timeoutMs = 300000, onPartial, systemMessage, ephemeral = false }) {
    const c = this.config();
    if (!c) throw new Error("No provider selected in settings.");
    if (!c.apiKey) throw new Error(`No API key for "${c.label}". Add one in settings.`);
    if (this.busy.has(sessionKey)) throw new Error("This conversation is still replying — wait or stop it.");

    const images = (this.supportsAttachments ? attachments : []).map((a) => ({
      mimeType: a.mimeType || "image/jpeg",
      data: stripDataUrl(a.dataUrl),
    }));

    if (ephemeral) {
      // Tool/navigation context — stored separately, NOT in permanent history
      const ctx = this.toolContexts.get(sessionKey) || [];
      ctx.push({ role: "user", text: text ?? "", images });
      this.toolContexts.set(sessionKey, ctx);
    } else {
      // Permanent message
      const h = this.histories.get(sessionKey) || [];
      h.push({ role: "user", text: text ?? "", images });
      this.histories.set(sessionKey, h);
    }

    this.busy.add(sessionKey);
    const ac = new AbortController();
    this.aborts.set(sessionKey, ac);
    const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);

    // Declare before try — catch block needs access to these
    const history = this.histories.get(sessionKey) || [];
    const toolCtx = this.toolContexts.get(sessionKey) || [];

    // CONTEXT ECONOMY:
    // 1. Prune stale bulky sections (old DOM snapshots) from earlier messages —
    //    only the newest ones ride along in full. Workers keep their working log
    //    in `history` (ephemeral:false), the planner in `toolCtx` — prune both.
    // 2. Collapse a very long permanent history (many past turns) into
    //    head + tail with an omission note.
    // Pruned messages stay byte-identical afterwards, so they remain a stable,
    // cacheable prefix; `stableCtxIdx` marks where that prefix ends.
    pruneEphemeralHistory(history, 2);
    collapseOldHistory(history);
    const stableCtxIdx = pruneEphemeralHistory(toolCtx, 2);

    if (systemMessage) this._systemTokens.set(sessionKey, estimateTokens(systemMessage));

    // Combine: permanent history (stable, cached prefix) + tool context (ephemeral, uncached tail)
    const allMessages = [...history, ...toolCtx];
    const activeList = ephemeral ? toolCtx : history; // which list to push assistant reply to
    const stableIdx = stableCtxIdx >= 0 ? history.length + stableCtxIdx : history.length - 1;

    let assistant = "";
    const onDelta = (chunk) => { assistant += chunk; onPartial?.(assistant); };
    // Per-request accumulator: message_start and message_delta of the SAME
    // request combine, but nothing leaks across requests (an aborted stream
    // must not mix this request's input with the previous request's output).
    const currentUsage = {};
    const onUsage = (u) => {
      Object.assign(currentUsage, u);
      this.lastUsage.set(sessionKey, { ...currentUsage, at: Date.now() });
    };
    try {
      if (c.format === "anthropic") await this._callAnthropic(c, allMessages, { onDelta, onUsage, signal: ac.signal, systemMessage, permanentCount: history.length, stableIdx });
      else await this._callOpenAI(c, allMessages, { onDelta, onUsage, signal: ac.signal, systemMessage });

      // Store assistant reply in the correct list
      activeList.push({ role: "assistant", text: assistant, images: [] });
      if (ephemeral) this.toolContexts.set(sessionKey, toolCtx);
      else this.histories.set(sessionKey, history);
      return assistant;
    } catch (e) {
      if (ac.signal.aborted) {
        // aborted by user/timeout — keep partial reply in the correct list
        if (assistant) activeList.push({ role: "assistant", text: assistant, images: [] });
        if (ephemeral) this.toolContexts.set(sessionKey, toolCtx);
        else this.histories.set(sessionKey, history);
        return assistant || null;
      }
      // Remove the failed user message from whichever list it was added to
      activeList.pop();
      if (ephemeral) this.toolContexts.set(sessionKey, toolCtx);
      else this.histories.set(sessionKey, history);
      throw new Error(friendly(e, c));
    } finally {
      clearTimeout(timer);
      this.busy.delete(sessionKey);
      this.aborts.delete(sessionKey);
    }
  }

  cancelRun(sessionKey) {
    this.aborts.get(sessionKey)?.abort("user");
    this.busy.delete(sessionKey);
  }

  // ---- OpenAI-compatible ----
  async _callOpenAI(c, history, { onDelta, onUsage, signal, systemMessage }) {
    const messages = [];
    if (systemMessage) messages.push({ role: "system", content: systemMessage });
    for (const m of history) {
      messages.push({
        role: m.role,
        content: m.images?.length
          ? [{ type: "text", text: m.text }, ...m.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimeType};base64,${im.data}` } }))]
          : m.text,
      });
    }
    const body = (tokenField, withUsage) => JSON.stringify({
      model: c.model, messages, stream: true, [tokenField]: c.maxTokens,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
    });

    // Adaptive 400 handling: gpt-5/o-series reject max_tokens (want
    // max_completion_tokens); some OpenAI-compatible servers reject
    // stream_options. Adjust the offending field and retry, max twice.
    let tokenField = "max_tokens", withUsage = true, res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST", headers: this._openaiHeaders(c), body: body(tokenField, withUsage), signal,
      });
      if (res.ok) break;
      const errText = await safeText(res);
      if (res.status === 400 && attempt < 2) {
        if (/max_completion_tokens/i.test(errText) && tokenField === "max_tokens") { tokenField = "max_completion_tokens"; continue; }
        if (/stream_options|include_usage/i.test(errText) && withUsage) { withUsage = false; continue; }
      }
      throw new Error(`HTTP ${res.status}: ${errText}`.slice(0, 400));
    }
    await streamSSE(res, (json) => {
      if (json.error) throw new Error(json.error.message || "provider error");
      const delta = json.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) onDelta(delta.content);
      if (json.usage && onUsage) {
        // OpenAI's prompt_tokens INCLUDES cached_tokens; report input exclusive
        // of the cached part so getContextTokens' provider-agnostic sum
        // (input + cacheRead + cacheWrite) equals the true prompt size.
        const cached = json.usage.prompt_tokens_details?.cached_tokens || 0;
        onUsage({
          input: Math.max(0, (json.usage.prompt_tokens || 0) - cached),
          output: json.usage.completion_tokens || 0,
          cacheRead: cached,
          cacheWrite: 0,
        });
      }
    });
  }

  // ---- Anthropic-compatible ----
  async _callAnthropic(c, allMessages, { onDelta, onUsage, signal, systemMessage, permanentCount = 0, stableIdx = -1 }) {
    const messages = allMessages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [{ type: "text", text: m.text }, ...m.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mimeType, data: im.data } }))]
        : m.text,
    }));

    // Cache breakpoints (Anthropic allows 4; we use up to 3):
    //  1. system prompt — never changes within a session
    //  2. last permanent message — stable across the whole turn
    //  3. last STABLE ephemeral message (already pruned, will never mutate) —
    //     rolls forward each step so the growing tool context is cached too,
    //     instead of being re-uploaded at full price on every step.
    const markCacheable = (idx) => {
      if (idx < 0 || idx >= messages.length) return;
      const msg = messages[idx];
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      } else if (Array.isArray(msg.content) && msg.content.length) {
        msg.content[msg.content.length - 1].cache_control = { type: "ephemeral" };
      }
    };
    markCacheable(permanentCount - 1);
    if (stableIdx > permanentCount - 1) markCacheable(stableIdx);

    const body = { model: c.model, max_tokens: c.maxTokens, stream: true, messages };
    if (systemMessage) {
      // Cache the system prompt too
      body.system = [{ type: "text", text: systemMessage, cache_control: { type: "ephemeral" } }];
    }
    const res = await fetch(`${c.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this._anthropicHeaders(c),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await safeText(res))}`.slice(0, 400));
    await streamSSE(res, (json) => {
      if (json.type === "error") throw new Error(json.error?.message || "Anthropic error");
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") onDelta(json.delta.text || "");
      if (json.type === "message_start" && json.message?.usage && onUsage) {
        const u = json.message.usage;
        onUsage({
          input: u.input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
        });
      }
      if (json.type === "message_delta" && json.usage?.output_tokens != null && onUsage) {
        onUsage({ output: json.usage.output_tokens });
      }
    });
  }
}

// ---- helpers ----

/**
 * Collapse a very long PERMANENT history (many past turns) into head + tail
 * with an omission note, so multi-day conversations can't crowd out the
 * context either. Mutates the array in place. Only message TEXT is touched —
 * roles keep alternating, so provider role-order rules still hold.
 */
function collapseOldHistory(history, maxChars = 120000, keepHead = 2, keepTail = 10) {
  if (!Array.isArray(history) || history.length <= keepHead + keepTail + 2) return;
  let total = 0;
  for (const m of history) total += (m?.text || "").length;
  if (total <= maxChars) return;
  let omitted = history.length - keepHead - keepTail;
  // Keep roles alternating across the seam (Anthropic requires it): if the
  // first kept tail message has the same role as the last head message, omit
  // one more so the sequence stays user/assistant/user/…
  if (history[keepHead - 1]?.role === history[keepHead + omitted]?.role) omitted++;
  if (omitted >= history.length - keepHead) return; // degenerate — nothing sane to keep
  history.splice(keepHead, omitted);
  const first = history[keepHead];
  history[keepHead] = {
    ...first,
    text: `[NOTE: ${omitted} earlier messages of this conversation were omitted to stay within the context limit.]\n\n${first.text || ""}`,
  };
}

function stripDataUrl(u) {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(u || "");
  return m ? m[1] : (u || "");
}

async function safeText(res) { try { return await res.text(); } catch { return ""; } }

function friendly(e, c) {
  const msg = String(e?.message || e);
  if (/\b401\b|unauthorized|invalid.*key|authentication/i.test(msg)) return `Bad API key for ${c.label}. Check in settings.`;
  if (/\b403\b|permission|forbidden/i.test(msg)) return `${c.label}: access denied (403) — check key permissions or model access.`;
  if (/\b404\b/.test(msg)) return `${c.label}: not found (404) — wrong model "${c.model}" or API address.`;
  if (/\b429\b|rate.?limit|quota/i.test(msg)) return `${c.label}: rate limit exceeded (429) — try later.`;
  if (/Failed to fetch|NetworkError|network error/i.test(msg)) return `${c.label}: can't reach API (network/CORS).`;
  return `${c.label}: ${msg}`;
}

// SSE parser working for both OpenAI and Anthropic — we only care about `data:` lines.
async function streamSSE(res, onJson) {
  if (!res.body) throw new Error("No response stream.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (!data) continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      onJson(json); // a thrown error (e.g. error frame) propagates to the caller
    }
  }
}
