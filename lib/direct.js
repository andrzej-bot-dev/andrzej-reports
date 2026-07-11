// Direct LLM client (direct mode — "without OpenClaw"): talks directly to a provider's API
// in OpenAI-compatible or Anthropic-compatible format. Maintains its own
// conversation history per session (APIs are stateless), streams responses (SSE)
// and exposes the same interface as OpenClawGateway, so the rest of the extension
// (controller, agent loop) works unchanged.

import { getPreset } from "./providers.js";

export class DirectBackend extends EventTarget {
  constructor({ getSettings, debug }) {
    super();
    this.getSettings = getSettings;
    this.debug = debug || (() => {});
    this.kind = "direct";
    this.connected = true;               // no persistent connection — readiness checked per request
    this.supportsAttachments = true;
    this.histories = new Map();          // sessionKey -> [{role, text, images:[{mimeType,data}]}]
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
  resetSession(sessionKey) { this.histories.delete(sessionKey); }
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
  async sendAndWaitFinal({ sessionKey, text, attachments = [], timeoutMs = 300000, onPartial, systemMessage }) {
    const c = this.config();
    if (!c) throw new Error("No provider selected in settings.");
    if (!c.apiKey) throw new Error(`No API key for "${c.label}". Add one in settings.`);
    if (this.busy.has(sessionKey)) throw new Error("This conversation is still replying — wait or stop it.");

    const history = this.histories.get(sessionKey) || [];
    const images = (this.supportsAttachments ? attachments : []).map((a) => ({
      mimeType: a.mimeType || "image/jpeg",
      data: stripDataUrl(a.dataUrl),
    }));
    history.push({ role: "user", text: text ?? "", images });
    this.histories.set(sessionKey, history);

    this.busy.add(sessionKey);
    const ac = new AbortController();
    this.aborts.set(sessionKey, ac);
    const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);

    let assistant = "";
    const onDelta = (chunk) => { assistant += chunk; onPartial?.(assistant); };
    try {
      if (c.format === "anthropic") await this._callAnthropic(c, history, { onDelta, signal: ac.signal, systemMessage });
      else await this._callOpenAI(c, history, { onDelta, signal: ac.signal, systemMessage });
      history.push({ role: "assistant", text: assistant, images: [] });
      return assistant;
    } catch (e) {
      if (ac.signal.aborted) {
        // aborted by user/timeout — keep what we got
        if (assistant) history.push({ role: "assistant", text: assistant, images: [] });
        return assistant || null;
      }
      history.pop(); // remove the failed user turn so it doesn't corrupt history
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
  async _callOpenAI(c, history, { onDelta, signal, systemMessage }) {
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
    const body = (tokenField) => JSON.stringify({ model: c.model, messages, stream: true, [tokenField]: c.maxTokens });

    let res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST", headers: this._openaiHeaders(c), body: body("max_tokens"), signal,
    });
    if (!res.ok) {
      const errText = await safeText(res);
      // gpt-5 / o-series reject max_tokens → retry with max_completion_tokens
      if (res.status === 400 && /max_completion_tokens/i.test(errText)) {
        res = await fetch(`${c.baseUrl}/chat/completions`, {
          method: "POST", headers: this._openaiHeaders(c), body: body("max_completion_tokens"), signal,
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await safeText(res)) || errText}`.slice(0, 400));
    }
    await streamSSE(res, (json) => {
      if (json.error) throw new Error(json.error.message || "provider error");
      const delta = json.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) onDelta(delta.content);
    });
  }

  // ---- Anthropic-compatible ----
  async _callAnthropic(c, history, { onDelta, signal, systemMessage }) {
    const messages = history.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [{ type: "text", text: m.text }, ...m.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mimeType, data: im.data } }))]
        : m.text,
    }));
    const body = { model: c.model, max_tokens: c.maxTokens, stream: true, messages };
    if (systemMessage) body.system = systemMessage;
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
    });
  }
}

// ---- helpers ----

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
