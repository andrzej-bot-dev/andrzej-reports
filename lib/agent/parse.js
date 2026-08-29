// Parsing helpers for the agent loop: reply parsing, control-tool classification,
// and small text utilities. Extracted from agent.js.

// Read-only tools — never reach the approval gate.
export const READ_ONLY_TOOLS = new Set([
  "snapshot", "read_page", "get_text", "page_info", "find", "wait", "wait_for",
  "tab_info", "screenshot", "highlight", "scroll", "switch_tab",
  "show_indicators", "hide_indicators", "update_cursor", "show_pill", "hide_pill",
  "quick_action",  // delegated through worker — worker handles its own approvals
]);

// Control "tools" the model uses to explicitly END the action loop. These are NOT
// browser actions — they never reach the approval gate or tools.run.
// Everything else with a "tool" field is treated as a browser action.
export const DONE_TOOLS = new Set(["done", "finish", "finished", "complete", "completed", "task_complete", "end"]);
export const ASK_TOOLS  = new Set(["ask", "ask_user", "question", "need_user", "clarify"]);

// Non-loop-ending control tools. These are intercepted inside the loop and used
// to drive richer behavior (live tab-group progress labels, mid-task verification)
// without terminating the turn.
export const PROGRESS_TOOLS = new Set(["progress", "set_progress", "status", "set_title"]);
export const VERIFY_TOOLS   = new Set(["verify", "verify_done", "checkpoint"]);

// Parallel fan-out: the planner delegates N INDEPENDENT sub-tasks, each to its own
// sub-agent running in its own background tab, concurrently (bounded). This is the
// "for each X, do Y" primitive — see AgentLoop.handleSpawnWorkers.
export const SPAWN_TOOLS = new Set(["spawn_workers", "parallel", "fan_out", "parallel_tasks", "spawn_tasks", "map_tasks"]);
// Sequential single-worker delegation (one sub-task at a time, shares the main tab).
export const WORKER_TOOLS = new Set(["multi_step", "quick_action"]);
// All delegation tools. Excluded from the per-action "verify" field requirement,
// since the sub-agent runs its own verification internally.
export const DELEGATION_TOOLS = new Set([...SPAWN_TOOLS, ...WORKER_TOOLS]);

// How many consecutive stale-ref failures on click/fill get an automatic fresh
// snapshot injected for retry before we hand the raw error back to the model.
export const MAX_AUTO_RETRIES = 4;

// Per-action self-verification: a state-changing action MUST carry a "verify"
// field citing snapshot evidence. If missing, we nudge the model to re-emit
// with verification. After this many re-emits without a verify field we stop
// insisting and just execute (robustness: don't deadlock on a non-compliant model).
export const MAX_VERIFY_NUDGES = 2;

// Heuristic: did the narration end with a question to the user? Used as a
// fallback so a genuine question ends the loop even without a {"tool":"ask"} block.
export function endsWithQuestion(text) {
  const t = String(text || "").replace(/\s+$/u, "");
  if (!t) return false;
  const lastLine = t.split("\n").pop().trim();
  // ends with ? (ASCII or fullwidth), optionally followed by a closing quote/paren
  return /[?？]["'”’)\]）】]*$/u.test(lastLine);
}

// Escape a string for safe embedding inside a JSON string literal (used when
// we splice LLM-generated text into [BROWSER_RESULT] JSON ourselves).
export function escapeForJson(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    .slice(0, 1000);
}

// Stable signature of an action for repeat-detection. We deliberately exclude
// volatile fields ("why", "verify", narration) so that the same logical
// action repeated verbatim is detected, while a model merely re-phrasing the
// justification is NOT flagged as a repeat.
export function actionSignature(action) {
  if (!action || !action.tool) return "";
  const key = { tool: action.tool };
  for (const k of ["ref", "value", "url", "key", "label", "selector", "to", "dy", "dx", "tabId", "code", "query", "dblclick"]) {
    if (action[k] !== undefined) key[k] = String(action[k]);
  }
  // Fan-out delegations carry their payload in an array — fold its shape into the
  // signature so two DIFFERENT batches aren't mistaken for a repeated action (an
  // identical batch re-emitted still matches, so genuine loops are still caught).
  const list = action.subtasks || action.tasks || action.workers || action.items;
  if (Array.isArray(list)) {
    key._n = list.length;
    key._sub = list
      .map(it => (typeof it === "string" ? it : (it && (it.goal || it.task || it.intent || it.text || it.query)) || ""))
      .join("|").slice(0, 300);
  }
  return JSON.stringify(key);
}

// Fix common LLM mistake: using ref as key name instead of value.
// e.g. {"tool":"click","ref_42":true} → {"tool":"click","ref":"ref_42"}
// Also strips null/empty coordinate fields some LLMs add.
function normalizeAction(obj) {
  if (!obj.ref) {
    const refKey = Object.keys(obj).find(k => /^ref_\d+$/.test(k) || /^e\d+$/.test(k));
    if (refKey) {
      obj.ref = refKey;
      delete obj[refKey];
    }
  }
  if (obj.click_x === null || obj.click_x === undefined) delete obj.click_x;
  if (obj.click_y === null || obj.click_y === undefined) delete obj.click_y;
  return obj;
}

function tryParseAction(s) {
  try {
    const obj = JSON.parse(s.trim());
    if (obj && typeof obj === "object" && typeof obj.tool === "string") {
      return normalizeAction(obj);
    }
  } catch { /* not JSON */ }
  return null;
}

// Route a parsed object into action vs. control. Returns true if it was a control block.
function routeObject(obj, state) {
  const tool = String(obj.tool || "").toLowerCase();
  if (DONE_TOOLS.has(tool)) { state.control = "done"; state.controlObj = obj; return true; }
  if (ASK_TOOLS.has(tool))  { state.control = "ask";  state.controlObj = obj; return true; }
  state.action = obj;
  return false;
}

// Extracts an action block from the agent's response.
// Returns { narration, action|null, control, controlObj, hadBlock }.
//  - action:   a browser action to execute (null if none / control block / malformed)
//  - control:  "done" | "ask" | null — an explicit loop-ending control block
//  - controlObj: the parsed control object (carries summary/question)
//  - hadBlock: a fenced/JSON block WAS present (even if it failed to parse or was control)
export function parseAgentReply(text) {
  if (!text) return { narration: "", action: null, control: null, controlObj: null, hadBlock: false };
  const fenceRe = /```(?:browser|browser-action|json-browser)\s*\n([\s\S]*?)```\s*$/m;
  const m = text.match(fenceRe);

  const state = { action: null, control: null, controlObj: null };
  let hadBlock = false;
  let narration = text;

  if (m) {
    hadBlock = true;
    const obj = tryParseAction(m[1]);
    if (obj) { routeObject(obj, state); narration = text.replace(m[0], "").trim(); }
  } else {
    // tolerance: entire response is bare JSON action or a ```json block with a tool
    const jsonFence = text.match(/```json\s*\n([\s\S]*?)```\s*$/m);
    if (jsonFence) {
      hadBlock = true;
      const obj = tryParseAction(jsonFence[1]);
      if (obj) { routeObject(obj, state); narration = text.replace(jsonFence[0], "").trim(); }
    } else {
      const obj = tryParseAction(text);
      if (obj) {
        hadBlock = true;
        const isCtrl = routeObject(obj, state);
        if (!isCtrl) narration = "";
      }
    }
  }
  return { narration, action: state.action, control: state.control, controlObj: state.controlObj, hadBlock };
}
