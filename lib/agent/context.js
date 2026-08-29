// lib/agent/context.js — context-economy helpers shared by the agent loop,
// the direct backend and browser workers.
//
// Bulky page state (DOM snapshots, page text) is wrapped in NAMED sections:
//
//   --- PAGE ELEMENTS ---
//   …tree…
//   --- END PAGE ELEMENTS ---
//
// so older messages can be pruned down to "(omitted)" stubs once superseded,
// while the surrounding message text stays byte-identical — keeping the pruned
// prefix a stable, provider-cacheable prefix.
//
// This module is intentionally LLM-free and dependency-free: it must also work
// at the moment of a hard context overflow, when no model call is possible.

// Matches a full marked section (name is backreferenced so nested/unrelated
// END markers can't truncate the match early). Stub forms ("NAME (omitted)")
// contain parentheses and therefore never match again — pruning is idempotent.
const SECTION_RE = /--- ([A-Z][A-Z0-9 _-]*) ---\r?\n[\s\S]*?\r?\n--- END \1 ---/g;

/** Wrap content in a named, prunable section. */
export function markSection(name, content) {
  return `--- ${name} ---\n${String(content ?? "")}\n--- END ${name} ---`;
}

/**
 * Replace every marked section's content with an "(omitted)" stub.
 * Idempotent: already-pruned stubs never match again.
 */
export function stripBulkySections(text) {
  if (typeof text !== "string" || !text.includes("--- END ")) return text;
  return text.replace(SECTION_RE, (_m, name) => `--- ${name} (omitted) ---\n--- END ${name} ---`);
}

/**
 * Prune bulky sections from all but the newest `keep` messages of an ephemeral
 * message list (mutates message.text in place — messages are never reordered).
 * Returns the index of the last STABLE (will-never-mutate-again) message, or
 * -1 when the whole list sits inside the keep window.
 */
export function pruneEphemeralHistory(list, keep = 2) {
  if (!Array.isArray(list)) return -1;
  const cutoff = list.length - Math.max(0, keep | 0);
  if (cutoff <= 0) return -1;
  for (let i = 0; i < cutoff; i++) {
    const m = list[i];
    if (m && typeof m.text === "string" && m.text.includes("--- END ")) {
      m.text = stripBulkySections(m.text);
    }
  }
  return cutoff - 1;
}

// ---------------------------------------------------------------- diffing

/**
 * Line-based diff of two snapshot trees. Returns { diff, ratio } where:
 *  - diff  — compact annotation relative to the OLD full snapshot: lines
 *            starting with "+" were added, "~" changed, "-" removed;
 *            unchanged lines are omitted entirely.
 *  - ratio — fraction of lines that changed (0…1+). Callers send the diff
 *            only when it is small (typically ratio <= 0.5), otherwise a
 *            fresh full snapshot.
 * Returns null when a diff isn't meaningful (empty input, tree too large to
 * diff in bounded memory, or the diff wouldn't be smaller than the full tree).
 */
export function diffSnapshots(oldText, newText) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  if (!oldText || !newText || !a.length || !b.length) return null;
  const n = a.length, m = b.length;
  // Bound the DP table (Int32 cells) — snapshots are capped (~12k chars) well
  // below this, the guard is just for pathological inputs.
  if (n * m > 4_000_000) return null;

  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w, next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }

  const out = [];
  let changed = 0;
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push("- " + a[i++]); changed++; }
    else { out.push("+ " + b[j++]); changed++; }
  }
  while (i < n) { out.push("- " + a[i++]); changed++; }
  while (j < m) { out.push("+ " + b[j++]); changed++; }
  if (!out.length) return { diff: "(no changes since last full snapshot)", ratio: 0 };

  // Collapse adjacent -/+ runs into "~ changed" pairs to match the documented
  // format (one "~" line per modified line — the NEW version).
  const paired = [];
  let k = 0;
  while (k < out.length) {
    if (!out[k].startsWith("- ")) { paired.push(out[k++]); continue; }
    let r = k;
    while (r < out.length && out[r].startsWith("- ")) r++;
    let s = r;
    while (s < out.length && out[s].startsWith("+ ")) s++;
    const rem = out.slice(k, r), add = out.slice(r, s);
    const p = Math.min(rem.length, add.length);
    for (let q = 0; q < p; q++) paired.push("~ " + add[q].slice(2));
    for (let q = p; q < rem.length; q++) paired.push(rem[q]);
    for (let q = p; q < add.length; q++) paired.push(add[q]);
    k = s;
  }

  const diff = paired.join("\n");
  // A diff bigger than the full tree it replaces buys nothing — send full.
  if (paired.length > 400 || diff.length >= String(newText).length) return null;
  return { diff, ratio: changed / Math.max(n, m) };
}

// ------------------------------------------------------------ safe JSON

/**
 * JSON.stringify that never explodes the context: string values are capped at
 * `fieldCap` chars and arrays at 200 entries; if the result still exceeds
 * `totalCap`, the caps are progressively halved (and arrays trimmed) until it
 * fits. The output is ALWAYS valid JSON — as a last resort the payload is
 * replaced by a small {truncated:true} stub with a preview.
 */
export function safeJsonStringify(obj, fieldCap = 2000, totalCap = 20000) {
  let cap = Math.max(20, Math.floor(fieldCap) || 2000);
  let arrMax = 200;
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = stringifyWithCaps(obj, cap, arrMax);
    if (out.length <= totalCap) return out;
    cap = Math.max(20, Math.floor(cap / 2));
    arrMax = Math.max(4, Math.floor(arrMax / 2));
  }
  let preview = "";
  try { preview = stringifyWithCaps(obj, 60, 4).slice(0, Math.min(totalCap, 800)); } catch { /* give up */ }
  return JSON.stringify({ truncated: true, note: "result too large to include in full", preview });
}

function stringifyWithCaps(value, cap, arrMax) {
  const seen = new WeakSet();
  const walk = (x, depth) => {
    if (typeof x === "string") return x.length > cap ? x.slice(0, cap) + "…" : x;
    if (x === null || typeof x === "bigint" || typeof x === "function" || typeof x === "symbol") {
      return typeof x === "bigint" ? String(x) : null;
    }
    if (typeof x !== "object") return x;
    if (seen.has(x)) return "[circular]";
    if (depth > 12) return "[deep]";
    seen.add(x);
    if (Array.isArray(x)) {
      const head = x.slice(0, arrMax).map((it) => walk(it, depth + 1));
      if (x.length > arrMax) head.push(`(+${x.length - arrMax} more)`);
      return head;
    }
    const o = {};
    for (const [key, val] of Object.entries(x)) o[key] = walk(val, depth + 1);
    return o;
  };
  try { return JSON.stringify(walk(value, 0)); }
  catch { return JSON.stringify({ unserializable: true }); }
}

// -------------------------------------------------------- token estimates

/** Rough token estimate: ~4 chars per token for typical mixed text. */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : (text == null ? "" : String(text));
  return Math.ceil(s.length / 4);
}

/**
 * Estimated tokens carried by a message list ({role, text, images:[dataUrl]}).
 * Images are base64 in this codebase — chars/4 heavily overestimates their
 * true token cost, which keeps the compaction trigger conservative (fires
 * early, never late).
 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (!m) continue;
    total += estimateTokens(m.text);
    if (typeof m.content === "string") total += estimateTokens(m.content);
    if (Array.isArray(m.images)) {
      for (const img of m.images) {
        total += estimateTokens(typeof img === "string" ? img : (img?.url || img?.dataUrl || ""));
      }
    }
  }
  return total;
}

// ------------------------------------------------------ overflow detection

// Error phrasings used by OpenAI-compatible and Anthropic endpoints when the
// request exceeds the model's context window. Kept tight on purpose: generic
// "too long" wording (e.g. a timeout note) must NOT trigger a compaction.
const OVERFLOW_RE = new RegExp(
  "context_length_exceeded|context length|context window|maximum context|context limit" +
  "|prompt is too long|too many (input )?tokens|input tokens? (exceed|too)" +
  "|token limit|exceeds? the (context|model|maximum|limit|token)" +
  "|reduce the (length|prompt|input)|payload too large|request entity too large",
  "i"
);

/** True when an error message looks like a context-window overflow. */
export function isContextOverflowError(msg) {
  if (!msg) return false;
  return OVERFLOW_RE.test(String(msg));
}
