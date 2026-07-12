// Fan-out executor: spawns N parallel BrowserWorkers, each pinned to its own tab.
//
// Used by both the planner (AgentLoop) and workers (BrowserWorker) for sub→sub-sub
// delegation. The recursion depth is capped by settings.fanOutMaxDepth.
//
// Flow:
//   1. Normalize subtasks (accepts tasks/subtasks/workers/items, bare strings or objects)
//   2. Create one tab per task via spawnWorkerTab (all in the same tab group, background tabs)
//   3. For each task: create a scoped BrowserTools view (shared CDPController, pinned tab)
//   4. Spawn a BrowserWorker per task with concurrency cap (Semaphore)
//   5. Each worker returns a compressed report { success, summary, observations, data }
//   6. Collect all reports and return them to the caller
//
// Tabs are CLOSED after completion — the compressed report is returned to the
// planner, so the tabs are no longer needed. This avoids tab clutter when
// many workers run. CDP debugger is detached before closing (removes the
// yellow bar).
// Workers auto-run non-sensitive browsing actions and deny sensitive ones (no
// approval-dialog contention — the single approval slot can't be shared by N
// parallel workers).

import { BrowserWorker } from "./worker.js";
import { Semaphore } from "./semaphore.js";
import { isSensitiveAction } from "./tools.js";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TASKS = 10;
const DEFAULT_WORKER_TIMEOUT = 180000; // 3 minutes per worker

/**
 * Normalize the many shapes an LLM may use for a fan-out into a clean
 * [{ goal, url|null, schema|null }] list. Accepts subtasks/tasks/workers/items,
 * each a bare string or an object with goal/task/intent/text/query (+ optional
 * url/startUrl and schema/result_schema). A top-level result_schema/schema
 * applies to every subtask that doesn't specify its own.
 */
export function normalizeSubtasks(action) {
  const raw = action.subtasks || action.tasks || action.workers || action.items || [];
  if (!Array.isArray(raw)) return [];
  const globalSchema = action.result_schema || action.schema || null;
  const out = [];
  for (const it of raw) {
    if (typeof it === "string") {
      if (it.trim()) out.push({ goal: it.trim(), url: null, schema: globalSchema });
    } else if (it && typeof it === "object") {
      const goal = it.goal || it.task || it.intent || it.text || it.query || "";
      if (goal && String(goal).trim()) {
        out.push({
          goal: String(goal).trim(),
          url: it.url || it.startUrl || it.start_url || null,
          schema: it.schema || it.result_schema || globalSchema,
        });
      }
    }
  }
  return out;
}

/**
 * Execute a fan-out: N parallel sub-workers, each in its own tab.
 *
 * @param {object} opts
 *   tasks        – array of { goal, url?, schema? } (from normalizeSubtasks)
 *   tools        – parent BrowserTools (used for tab creation + scopedTo)
 *   getSettings  – () => current settings
 *   approvalGate – async (action) => "run"|"deny"  (per-worker action approval)
 *   isStopped    – () => boolean  (abort all workers if true)
 *   onProgress   – (index, total, label) => void  (live progress updates)
 *   onWorkerStart– (index, total, tabId) => void  (called when a worker starts)
 *   onWorkerComplete – (index, total, report) => void  (called when a worker finishes)
 *   depth        – current recursion depth (0 = planner level)
 *   why          – reason for the fan-out (for logging)
 * @returns {Promise<Array<{task, success, summary, observations?, data?, tabId?}>>}
 */
export async function executeFanOut({
  tasks,
  tools,
  getSettings,
  approvalGate,
  isStopped,
  onProgress,
  onWorkerStart,
  onWorkerComplete,
  depth = 0,
  why = "",
}) {
  const settings = getSettings();
  const maxDepth = settings.fanOutMaxDepth || DEFAULT_MAX_DEPTH;

  if (depth >= maxDepth) {
    return tasks.map((t) => ({
      task: t.goal || "",
      success: false,
      summary: `Max fan-out depth (${maxDepth}) reached — cannot delegate further.`,
    }));
  }

  const maxTasks = settings.fanOutMaxTasks || DEFAULT_MAX_TASKS;
  const cappedTasks = tasks.slice(0, maxTasks);
  const total = cappedTasks.length;
  const concurrency = Math.min(settings.fanOutConcurrency || DEFAULT_CONCURRENCY, total);
  const timeoutMs = settings.fanOutWorkerTimeout || DEFAULT_WORKER_TIMEOUT;
  const sem = new Semaphore(concurrency);

  // Create tabs for each task (in parallel — tab creation is fast and independent)
  const tabResults = await Promise.allSettled(
    cappedTasks.map((task) => tools.spawnWorkerTab(task.url))
  );

  // Worker approval gate: auto-run non-sensitive, deny sensitive.
  // This avoids approval-dialog contention (the single pendingApproval slot
  // can't be safely shared by N parallel workers). Sensitive actions are denied
  // — the planner should handle those sequentially after aggregating results.
  const workerGate = approvalGate
    ? async (wAction) => {
        if (isSensitiveAction(wAction, "")) return "deny";
        return approvalGate(wAction);
      }
    : async (wAction) => isSensitiveAction(wAction, "") ? "deny" : "run";

  // Run workers with concurrency cap
  const promises = cappedTasks.map((task, i) =>
    sem.run(async () => {
      const tabResult = tabResults[i];
      const tabId = tabResult.status === "fulfilled" ? tabResult.value : null;

      if (isStopped?.()) {
        const report = { success: false, summary: "Fan-out stopped by user.", observations: null, data: null };
        onWorkerComplete?.(i, total, report);
        if (tabId != null) tools.closeWorkerTab(tabId).catch(() => {});
        return { task: task.goal, ...report };
      }

      if (tabId == null) {
        const report = {
          success: false,
          summary: `Failed to create tab: ${tabResult.reason?.message || tabResult.reason}`,
          observations: null, data: null,
        };
        onWorkerComplete?.(i, total, report);
        return { task: task.goal, ...report };
      }

      // Stagger worker starts by a small delay to reduce concurrent load on
      // both the LLM API (rate limits) and Chrome's debugger API (CDP attach).
      if (i > 0) await new Promise((r) => setTimeout(r, Math.min(i, concurrency) * 500));
      onWorkerStart?.(i, total, tabId);
      onProgress?.(i, total, "starting");

      try {
        const report = await runWorkerWithTimeout(
          task, tabId, tools, getSettings, workerGate, depth, i, total,
          onProgress, timeoutMs, isStopped
        );
        onWorkerComplete?.(i, total, report);
        return { task: task.goal, ...report };
      } catch (e) {
        const report = { success: false, summary: `Worker error: ${e.message || e}`, observations: null, data: null };
        onWorkerComplete?.(i, total, report);
        return { task: task.goal, ...report };
      } finally {
        // Close the worker tab — the report is already collected, so the tab
        // is no longer needed. This prevents tab clutter from parallel fan-outs.
        tools.closeWorkerTab(tabId).catch(() => {});
      }
    })
  );

  return Promise.all(promises);
}

async function runWorkerWithTimeout(task, tabId, parentTools, getSettings, workerGate, depth, index, total, onProgress, timeoutMs, isStopped) {
  if (isStopped?.()) {
    return { success: false, summary: "Fan-out stopped by user.", observations: null, data: null };
  }

  // Use scopedTo: shares the parent's CDPController (one `attached` Set for all
  // tabs), but every op targets this worker's pinned tab. No CDP contention
  // because each worker operates on a different tab.
  const scoped = parentTools.scopedTo(tabId);

  const worker = new BrowserWorker({
    tools: scoped,
    getSettings,
    depth: depth + 1,
    onStep: (step, _body, label) => {
      onProgress?.(index, total, label || `step ${step + 1}`);
    },
  });

  const timer = setTimeout(() => worker.stop(), timeoutMs);

  // Periodically check if the parent was stopped — abort the worker if so
  const stopChecker = setInterval(() => {
    if (isStopped?.()) worker.stop();
  }, 500);

  try {
    const report = await worker.execute(task.goal, {
      approvalGate: workerGate,
      fanOutDepth: depth + 1,
      resultSchema: task.schema || null,
    });

    if (isStopped?.()) {
      return { ...report, summary: report.summary ? `Stopped: ${report.summary}` : "Stopped by user." };
    }

    return report;
  } finally {
    clearInterval(stopChecker);
    clearTimeout(timer);
    worker.close();
    // Tab closing is handled by the caller (executeFanOut) in its finally block.
  }
}
