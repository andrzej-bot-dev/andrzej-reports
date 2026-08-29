// StatelessBrowserWorker — sub-agent for browser DOM heavy lifting.
//
// The worker receives a task ("click X and confirm", "fill form with Y"),
// a DOM snapshot, and executes actions autonomously using the same BrowserTools.
// It returns a COMPRESSED report (not the full DOM) back to the planner.
//
// Key difference vs planner:
// - Stateless: no conversation history between tasks
// - Gets fresh DOM each invocation
// - Returns { success, summary, observations } — not raw browser output
// - Can use a cheaper/faster model (e.g. Flash)
// - Has its own DirectBackend instance (no shared history)

import { DirectBackend } from "./direct.js";
import { getPreset } from "./providers.js";
import { markSection, safeJsonStringify } from "./agent/context.js";

// Fan-out sizing (shared with AgentLoop.handleSpawnWorkers).
export const DEFAULT_WORKER_CONCURRENCY = 4;  // lanes running at once by default
export const MAX_WORKER_CONCURRENCY = 6;      // hard ceiling on concurrent tabs/LLM calls
export const MAX_SUBTASKS = 20;               // hard ceiling on sub-tasks per fan-out call

const WORKER_PREAMBLETS = `You are a browser automation worker. You receive a task and a DOM snapshot. Execute browser actions to complete the task, then report back.

RULES:
- Execute the task autonomously using browser tools (click, fill, press, scroll, etc.)
- After each action you'll get a [BROWSER_RESULT] — adapt and continue
- You may start on a blank page (about:blank). If so, your FIRST action should be {"tool":"navigate","url":"…"} to a relevant page.
- READ-ONLY / RESEARCH scope: do NOT purchase, checkout, pay, submit payment or login credentials, place orders, or delete anything. If the task truly requires that, stop and report it back instead — the main agent will handle it.
- When done, reply with ONLY your report (no browser action block) — this ends your task
- If you can't complete the task after reasonable attempts, report what went wrong

REPORT FORMAT (when done, no action block):
RESULT: success | partial | failed
SUMMARY: <1-2 sentences describing what happened>
OBSERVATIONS: <optional: key data the planner needs to decide next steps>
  - Only include if the planner needs specific data (prices, options, form values, etc.)
  - Format as bullet points, max 5 items
  - Omit entirely for simple actions (click, fill, scroll)

EXAMPLES:
Task: "Add the red shirt size M to cart"
→ click size M → click add to cart → 
RESULT: success
SUMMARY: Added red shirt (size M) to cart. Cart now shows 1 item.
OBSERVATIONS:
- Price: 249 kr
- Size M in stock

Task: "Scroll down and find all product names"
→ scroll → snapshot →
RESULT: success
SUMMARY: Found 8 products on the page.
OBSERVATIONS:
- Cotton Tee — 99 kr
- Linen Shirt — 299 kr
- ... (5 more)

Task: "Click the login button"
→ click login →
RESULT: success
SUMMARY: Clicked login button. Login form appeared.`.trim();

const WORKER_TOOL_DOC = `
TOOLS (one JSON object per action):
- {"tool":"snapshot"} — layout of current page with refs (e1, e2, …)
- {"tool":"get_text","maxChars":20000} — readable text of the page
- {"tool":"click","ref":"e12"} — click element
- {"tool":"fill","ref":"e5","value":"text","pressEnter":false} — type into input
- {"tool":"press","key":"Enter"} — key press
- {"tool":"select_option","ref":"e7","label":"Poland"} — select option
- {"tool":"scroll","to":"bottom"} | {"tool":"scroll","dy":600} — scroll
- {"tool":"find","query":"text"} — find elements by text
- {"tool":"wait_for","selector":"css","text":"fragment","timeoutMs":8000} — wait
- {"tool":"wait","ms":1500} — plain wait`.trim();

const MAX_WORKER_STEPS = 12;

export class BrowserWorker {
  /**
   * @param {object} deps
   *  tools    – BrowserTools instance (shared with planner, same tab group)
   *  getSettings – () => current settings
   *  workerModel  – optional model override (e.g. cheaper/faster)
   *  onStep   – callback(step, narration) for UI progress
   *  onAction – callback(action) for approval gate
   */
  constructor({ tools, getSettings, workerModel, onStep, onAction }) {
    this.tools = tools;
    this.getSettings = getSettings;
    this.workerModel = workerModel || null;
    this.onStep = onStep || (() => {});
    this.onAction = onAction || null;
    this.backend = null;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    if (this.backend) {
      for (const sk of this.backend.aborts?.keys?.() || []) {
        this.backend.aborts.get(sk)?.abort("worker-stopped");
      }
    }
  }

  /** Lazily create a stateless DirectBackend for the worker. */
  getBackend() {
    if (this.backend) return this.backend;
    const s = this.getSettings();
    // Worker uses its own DirectBackend — stateless, no shared history
    this.backend = new DirectBackend({
      getSettings: () => {
        const base = this.getSettings();
        // Override model if workerModel is set
        if (this.workerModel && this.workerModel !== base.directModel) {
          return { ...base, directModel: this.workerModel };
        }
        return base;
      },
    });
    const provider = s.directProvider || getPreset(s.backendMode === "openclaw" ? null : s.directProvider)?.id;
    if (provider) this.backend.setSelection(provider, this.workerModel || s.directModel || "");
    return this.backend;
  }

  /**
   * Execute a task on the page. Returns { success, summary, observations, data }.
   * @param {string} task – natural language instruction
   * @param {object} opts
   *  approvalGate – async (action) => "run"|"deny" (optional)
   *  resultSchema – optional object/string describing the JSON the worker must
   *                 return; when set, the final report is a ```result JSON block
   *                 and the parsed object is returned as `data` (for reliable
   *                 aggregation by the planner).
   */
  async execute(task, { approvalGate, resultSchema = null } = {}) {
    const settings = this.getSettings();
    const sessionKey = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Build initial context: tab info + DOM snapshot
    const info = await this.tools.tabInfo();
    let context = "";
    if (info.ok) {
      context += `[TAB] ${info.url} — "${info.title}"\n`;
    }
    // Get fresh DOM snapshot (marked section → prunable once superseded)
    let lastSnapshot = ""; // worker's own view — feeds the sensitive-action gate
    const snap = await this.tools.run({ tool: "snapshot" });
    if (snap.ok && snap.snapshot) {
      lastSnapshot = snap.snapshot;
      let snapStr = snap.snapshot;
      if (snapStr.length > 12000) snapStr = snapStr.slice(0, 12000) + "…(truncated)";
      context += markSection("PAGE ELEMENTS", snapStr) + "\n";
    }
    // Also get page text for context
    const text = await this.tools.run({ tool: "get_text", maxChars: 8000 });
    if (text.ok && text.text) {
      context += markSection("PAGE TEXT", text.text.slice(0, 8000)) + "\n";
    }

    const systemMessage = `${WORKER_PREAMBLETS}\n\n${WORKER_TOOL_DOC}${resultSchema ? schemaInstruction(resultSchema) : ""}`;
    let body = `${context}\n[TASK]\n${task}`;

    const backend = this.getBackend();

    for (let step = 0; step < MAX_WORKER_STEPS; step++) {
      if (this.stopped) return { success: false, summary: "Worker stopped by user.", observations: null };
      this.onStep(step, body);

      let reply;
      try {
        const workerStart = Date.now();
        // Update working label with worker progress
        this.onStep(step, body, `Worker step ${step + 1}/${MAX_WORKER_STEPS} — waiting for LLM…`);
        reply = await backend.sendAndWaitFinal({
          sessionKey,
          text: body,
          systemMessage,
          ephemeral: false, // worker is stateless — use simple history
          timeoutMs: 120000,
        });
        const workerMs = Date.now() - workerStart;
        if (workerMs > 5000) {
          this.onStep(step, body, `Worker step ${step + 1} — LLM took ${(workerMs/1000).toFixed(1)}s`);
        }
      } catch (e) {
        return { success: false, summary: `Worker error after ${step} steps: ${e.message}. The LLM may be overloaded or the request timed out (120s).`, observations: null };
      }

      if (!reply) return { success: false, summary: "Worker got no response.", observations: null };

      // Parse reply: action block or final report
      const { narration, action } = parseWorkerReply(reply);

      if (!action) {
        // Final report — parse it (structured when a schema was requested)
        return resultSchema
          ? parseStructuredReport(narration || reply)
          : parseReport(narration || reply);
      }

      // Approval gate for non-read-only actions — pass the worker's own latest
      // snapshot so sensitive-click detection can see the element's line.
      if (approvalGate && !READ_ONLY.has(action.tool)) {
        const decision = await approvalGate(action, lastSnapshot);
        if (decision === "deny") {
          body = `[BROWSER_RESULT] This action was denied (sensitive actions are not allowed for research workers). Try a different approach or report back.`;
          continue;
        }
      }

      // Execute action
      const result = await this.tools.run(action);
      if (result?.ok && typeof result.snapshot === "string" && result.snapshot) lastSnapshot = result.snapshot;

      // Build result message (compact — no auto-snapshot, worker requests if needed).
      // Bulky content goes into marked sections (prunable, keeps the JSON valid).
      if (action.tool === "screenshot" && result.ok) {
        body = `[BROWSER_RESULT] ${JSON.stringify({ tool: "screenshot", ok: true, width: result.width, height: result.height })}`;
      } else if ((action.tool === "snapshot" || action.tool === "read_page") && result.ok && result.snapshot) {
        let snapStr = result.snapshot;
        if (snapStr.length > 10000) snapStr = snapStr.slice(0, 10000) + "…(truncated)";
        body = `[BROWSER_RESULT] {"tool":"snapshot","ok":true}\n` + markSection("PAGE ELEMENTS", snapStr);
      } else if (action.tool === "get_text" && result.ok && typeof result.text === "string") {
        body = `[BROWSER_RESULT] {"tool":"get_text","ok":true}\n` + markSection("PAGE TEXT", result.text.slice(0, 8000));
      } else {
        const compact = { tool: action.tool, ...result };
        delete compact.snapshot;
        body = `[BROWSER_RESULT] ${safeJsonStringify(compact, 3000, 15000)}`;
      }

      // After page-changing actions, add brief tab context
      if (["click", "navigate", "back", "new_tab", "press", "fill", "switch_tab"].includes(action.tool)) {
        const waitMs = action.tool === "click" ? 1000 : 700;
        await new Promise(r => setTimeout(r, waitMs));
        const info2 = await this.tools.tabInfo();
        if (info2.ok) body += `\n[TAB] ${info2.url} — "${info2.title}"`;
      }
    }

    // Exceeded max steps
    return { success: false, summary: `Worker exceeded ${MAX_WORKER_STEPS} steps without completing.`, observations: null };
  }

  close() {
    this.backend?.close?.();
    this.backend = null;
  }
}

// ---- helpers ----

const READ_ONLY = new Set([
  "snapshot", "get_text", "page_info", "find", "wait", "wait_for",
  "tab_info", "screenshot", "highlight", "scroll", "switch_tab",
]);

function parseWorkerReply(text) {
  if (!text) return { narration: "", action: null };
  const fenceRe = /```(?:browser|browser-action|json-browser|json)\s*\n([\s\S]*?)```\s*$/m;
  let m = text.match(fenceRe);
  let action = null;
  let narration = text;

  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s.trim());
      if (obj && typeof obj === "object" && typeof obj.tool === "string") return obj;
    } catch { /* not JSON */ }
    return null;
  };

  if (m) {
    action = tryParse(m[1]);
    if (action) narration = text.replace(m[0], "").trim();
  } else {
    const a = tryParse(text);
    if (a) { action = a; narration = ""; }
  }
  return { narration, action };
}

/** Render a result-schema into an instruction appended to the worker system prompt. */
function schemaInstruction(schema) {
  let desc;
  try { desc = typeof schema === "string" ? schema : JSON.stringify(schema); }
  catch { desc = String(schema); }
  return `

WHEN DONE — RETURN STRUCTURED JSON:
Instead of the RESULT/SUMMARY text format, end your task by replying with ONLY a fenced code block tagged \`result\` containing a single JSON object with these fields:
${desc}
Always also include a short "summary" string. If you could not complete the task, still return the JSON with "success": false and a "summary" explaining why.
Example:
\`\`\`result
{"success": true, "summary": "…", ...}
\`\`\``;
}

/** Extract a JSON object from a worker's final reply (```result / ```json block, else last {...}). */
function extractJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:result|json)\s*\n([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1] : null;
  if (!candidate) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) candidate = text.slice(start, end + 1);
  }
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate.trim());
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

/** Parse a schema-constrained worker reply into { success, summary, observations, data }. */
function parseStructuredReport(text) {
  const data = extractJsonBlock(text);
  if (!data) {
    // Model ignored the schema — fall back to the text report so we don't lose the result.
    return { ...parseReport(text), data: null };
  }
  const success = data.success !== false && !data.error;
  let summary = data.summary || data.note || data.title || "";
  if (!summary) summary = text.replace(/```[\s\S]*?```/g, "").trim().slice(0, 200) || "completed";
  return {
    success,
    summary: String(summary).slice(0, 400),
    observations: Array.isArray(data.observations) ? data.observations.slice(0, 8) : null,
    data,
  };
}

function parseReport(text) {
  const result = { success: false, summary: text.slice(0, 500), observations: null };

  const resultMatch = text.match(/RESULT:\s*(success|partial|failed)/i);
  if (resultMatch) {
    result.success = resultMatch[1].toLowerCase() !== "failed";
    if (resultMatch[1].toLowerCase() === "partial") result.success = true;
  }

  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\n(?:OBSERVATIONS:|$)|$)/is);
  if (summaryMatch) result.summary = summaryMatch[1].trim();

  const obsMatch = text.match(/OBSERVATIONS:\s*\n([\s\S]*?)$/i);
  if (obsMatch) {
    const items = obsMatch[1].split("\n")
      .map(l => l.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);
    if (items.length) result.observations = items.slice(0, 8);
  }

  return result;
}
