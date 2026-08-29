// lib/agent/context.js — context-budget helpers for the agent loop.
//
// The context strategy has three layers:
//  1. MARKED SECTIONS: everything bulky sent to the LLM (DOM snapshots, page
//     text) is wrapped in `--- NAME --- … --- END NAME ---` markers, so it can
//     be found and pruned later.
//  2. PRUNING: before every request, older messages have their marked sections
//     replaced by one-line stubs — only the newest snapshots ride along in
//     full. This keeps a 100-step turn from carrying 100 DOM snapshots.
//  3. DIFFS: after an action, instead of a full re-snapshot the model gets a
//     diff against the previous snapshot (refs are stable across snapshots),
//     which on a typical SPA click is ~1% of the full tree.
//
// Plus: token estimation, always-valid-JSON serialization, and detection of
// provider "context window exceeded" errors (which trigger turn compaction).
//
// Pure functions only — no chrome.* APIs — so this module is unit-testable.

// ---------------------------------------------------------------- sections

export function markSection(name, content) {
  // Page content is untrusted: a page whose visible text contains a line like
  // "--- END PAGE TEXT ---" would otherwise close the section early, letting
  // the rest escape pruning (and framing). Neutralize any marker-shaped line.
  const safe = String(content ?? "").replace(/^--- (END )?([A-Z0-9 _-]{1,40}) ---.*$/gm, "-\u00ad-- $1$2 ---");
  return `--- ${name} ---\n${safe}\n--- END ${name} ---`;
}

// The closer is line-anchored via lookahead so a forged "--- END X --- junk"
// line (which the neutralizer above also catches) can never close a section.
const SECTION_RE = /--- ([A-Z][A-Z0-9 _-]{0,40}?) ---\n[\s\S]*?\n--- END \1 ---(?=\n|$)/g;

/** Replace every marked section in `text` with a one-line stub. */
export function stripBulkySections(text) {
  return String(text || "").replace(
    SECTION_RE,
    (_m, name) => `--- ${name} (omitted — superseded by a newer snapshot; re-run the tool if needed) ---`,
  );
}

export function hasBulkySection(text) {
  SECTION_RE.lastIndex = 0;
  return SECTION_RE.test(String(text || ""));
}

/** Classify the marked sections a message carries. */
function classifySections(text) {
  SECTION_RE.lastIndex = 0;
  let m;
  const c = { elements: false, otherFull: false, diff: false, any: false };
  while ((m = SECTION_RE.exec(String(text || ""))) !== null) {
    c.any = true;
    if (/ DIFF$/.test(m[1])) c.diff = true;
    else if (m[1] === "PAGE ELEMENTS") c.elements = true;
    else c.otherFull = true;
  }
  return c;
}

/**
 * Strip marked sections from older messages. Mutates in place (we own them;
 * already-pruned messages stay byte-identical forever, which keeps them
 * cacheable as a stable prefix). Two pools:
 *  - full content (PAGE ELEMENTS / PAGE TEXT): keep the last `keepFull` —
 *    diffs are computed against the last FULL snapshot, so it must survive;
 *  - diff messages (* DIFF sections): CUMULATIVE vs that full snapshot, so
 *    only the latest one matters — keep the last `keepDiffs`.
 *
 * Returns the index of the last message of the STABLE PREFIX — everything up
 * to and including it will never change again, so it is a safe place for a
 * provider cache breakpoint. Returns -1 when even the first message may still
 * change.
 */
export function pruneEphemeralHistory(messages, keepFull = 2, keepDiffs = 1) {
  // THREE pools, so they can't evict each other: PAGE ELEMENTS full snapshots
  // are the base every later diff refers to — a burst of get_text results
  // (PAGE TEXT pool) must never push the diff base out of the window.
  const elemIdx = [], textIdx = [], diffIdx = [];
  for (let i = 0; i < (messages?.length || 0); i++) {
    const c = classifySections(messages[i]?.text);
    if (!c.any) continue;
    if (c.elements) elemIdx.push(i);      // messages carrying a full snapshot
    else if (c.otherFull) textIdx.push(i); // page text & other full content
    else diffIdx.push(i);                  // diff-only messages
  }
  const strip = (i) => { messages[i].text = stripBulkySections(messages[i].text); };
  for (let k = 0; k < elemIdx.length - keepFull; k++) strip(elemIdx[k]);
  for (let k = 0; k < textIdx.length - keepFull; k++) strip(textIdx[k]);
  for (let k = 0; k < diffIdx.length - keepDiffs; k++) strip(diffIdx[k]);
  // Stable prefix ends just before the first message still carrying full bulk.
  const kept = [];
  if (elemIdx.length > 0) kept.push(elemIdx[Math.max(0, elemIdx.length - keepFull)]);
  if (textIdx.length > 0) kept.push(textIdx[Math.max(0, textIdx.length - keepFull)]);
  if (diffIdx.length > 0) kept.push(diffIdx[Math.max(0, diffIdx.length - keepDiffs)]);
  const firstFull = kept.length ? Math.min(...kept) : -1;
  return firstFull === -1 ? (messages?.length || 0) - 1 : firstFull - 1;
}

// ---------------------------------------------------------------- tokens

/** Rough token estimate (~4 chars/token) — used when the API gave no usage yet. */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/** Estimate tokens for a message list (text + a flat cost per attached image). */
export function estimateMessagesTokens(messages) {
  let t = 0;
  for (const m of messages || []) {
    t += estimateTokens(m?.text) + (m?.images?.length || 0) * 1600 + 4;
  }
  return t;
}

/** Does this provider error mean "the request exceeded the context window"? */
export function isContextOverflowError(message) {
  const m = String(message || "");
  // Rate/quota throttles often say "too many tokens (per minute)" — that is
  // NOT a context overflow, and compaction wouldn't help.
  if (/rate.?limit|per min(ute)?|tpm|quota|429/i.test(m)) return false;
  return /context[_ ](length|window)|context_length_exceeded|maximum context length|prompt is too long|input (is )?too long|too many tokens|exceeds? the (model'?s )?(context|token)|max(imum)? (input )?tokens? (per request|exceeded)|input length and `?max_?tokens`? exceed/i
    .test(m);
}

// ---------------------------------------------------------------- safe JSON

/**
 * JSON.stringify that truncates long string values FIRST, so the output is
 * always valid, parseable JSON — never a sliced-off tail that the model then
 * tries (and fails) to make sense of.
 */
export function safeJsonStringify(obj, maxFieldChars = 4000, maxTotal = 24000) {
  const seen = new WeakSet();
  const trim = (v) => {
    if (typeof v === "string") {
      return v.length > maxFieldChars
        ? v.slice(0, maxFieldChars) + `… [truncated, ${v.length - maxFieldChars} more chars]`
        : v;
    }
    if (Array.isArray(v)) return v.slice(0, 100).map(trim);
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      const out = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ >= 60) { out["…"] = "more fields omitted"; break; }
        out[k] = trim(v[k]);
      }
      return out;
    }
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return String(v);
    return v;
  };
  let s;
  try { s = JSON.stringify(trim(obj)); }
  catch { s = JSON.stringify({ ok: false, error: "unserializable result" }); }
  if (s.length > maxTotal && maxFieldChars > 250) {
    return safeJsonStringify(obj, Math.floor(maxFieldChars / 8), maxTotal);
  }
  if (s.length > maxTotal) {
    // Size driven by STRUCTURE (huge arrays / deep nesting), not string length —
    // field truncation can't shrink it. Replace with a compact, valid summary.
    return JSON.stringify({
      tool: obj?.tool, ok: obj?.ok !== false,
      note: `result too large for the context (${s.length} chars) — omitted; re-run with narrower arguments`,
    });
  }
  return s;
}

// ---------------------------------------------------------------- snapshot diff

const REF_RE = /\[((?:ref_|e)\d+)\]/;

function splitSnapshot(text) {
  const lines = String(text || "").split("\n");
  let i = 0;
  while (i < lines.length && (/^(URL|TITLE|VIEWPORT):/.test(lines[i]) || lines[i].trim() === "")) i++;
  return { header: lines.slice(0, i).filter(l => l.trim()), body: lines.slice(i) };
}

/** The line with quoted spans (page-controlled labels/attribute values) blanked,
 *  so a label containing a literal "[ref_2]" can't hijack that ref's identity. */
function unquoted(line) {
  return String(line).replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function indexLines(bodyLines) {
  const byRef = new Map();   // ref -> full line
  const plain = new Map();   // trimmed line -> count (ref-less lines: options, notes)
  for (const raw of bodyLines) {
    if (!raw.trim()) continue;
    const m = unquoted(raw).match(REF_RE);
    if (m) byRef.set(m[1], raw);
    else plain.set(raw.trim(), (plain.get(raw.trim()) || 0) + 1);
  }
  return { byRef, plain };
}

/**
 * Diff two snapshots of the SAME page (refs are stable across snapshots, so a
 * ref present in both with identical text is unchanged). Returns null when the
 * snapshots are of different URLs (diff would be meaningless — send full).
 * Otherwise { diff, ratio, changedCount } where `ratio` is changed/total —
 * callers send the full snapshot instead when the ratio is high.
 */
export function diffSnapshots(prevText, newText) {
  const prev = splitSnapshot(prevText);
  const next = splitSnapshot(newText);
  const prevUrl = prev.header.find(l => l.startsWith("URL:"));
  const nextUrl = next.header.find(l => l.startsWith("URL:"));
  if (!prevUrl || !nextUrl || prevUrl !== nextUrl) return null;

  const a = indexLines(prev.body);
  const b = indexLines(next.body);

  const added = [], changed = [], removed = [];
  for (const [ref, line] of b.byRef) {
    const old = a.byRef.get(ref);
    if (old === undefined) added.push(line);
    else if (old !== line) changed.push(line);
  }
  for (const [ref, line] of a.byRef) {
    if (!b.byRef.has(ref)) {
      const t = line.trim();
      removed.push(t.length > 90 ? t.slice(0, 90) + "…" : t);
    }
  }
  const plainAdded = [], plainRemoved = [];
  for (const [l, n] of b.plain) {
    for (let k = n - (a.plain.get(l) || 0); k > 0; k--) plainAdded.push(l);
  }
  for (const [l, n] of a.plain) {
    for (let k = n - (b.plain.get(l) || 0); k > 0; k--) plainRemoved.push(l);
  }

  let totalNew = b.byRef.size;
  for (const n of b.plain.values()) totalNew += n;
  const changedCount = added.length + changed.length + removed.length + plainAdded.length + plainRemoved.length;
  const ratio = totalNew ? changedCount / totalNew : (changedCount ? 1 : 0);

  // The maps are order-blind — a pure reorder (sort, drag-drop) would otherwise
  // read as "no changes". Compare the sequence of refs common to both.
  const commonSeq = (idx, other) => {
    const seq = [];
    for (const ref of idx.byRef.keys()) if (other.byRef.has(ref)) seq.push(ref);
    return seq.join(",");
  };
  // Same membership, different order ⇔ the common refs appear in a different
  // sequence in the old vs. new snapshot.
  const reordered = !changedCount && commonSeq(a, b) !== commonSeq(b, a);

  const out = [...next.header, ""];
  if (!changedCount && reordered) {
    out.push("(same elements, but their ORDER on the page changed — refs remain valid; use {\"tool\":\"snapshot\",\"full\":true} if the order matters)");
  } else if (!changedCount) {
    out.push("(no visible changes since the previous snapshot — all elements and refs unchanged)");
  } else {
    for (const l of added) out.push("+ " + l.trim());
    for (const l of plainAdded) out.push("+ " + l);
    for (const l of changed) out.push("~ " + l.trim());
    for (const l of removed) out.push("- " + l);
    for (const l of plainRemoved) out.push("- " + l);
    out.push(`(${added.length + plainAdded.length} added, ${changed.length} changed, ${removed.length + plainRemoved.length} removed of ${totalNew} total — unchanged elements are NOT listed; their refs remain valid)`);
  }
  return { diff: out.join("\n"), ratio, changedCount };
}
