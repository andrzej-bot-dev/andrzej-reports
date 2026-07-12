// Agent loop: sends messages to the backend, parses browser action blocks from
// responses, executes them locally (content script / tabs API)
// and sends back results, until the agent considers the task done.
//
// Protocol with the agent: the agent replies with normal text (narration for
// the user), and when it wants to perform an action, it ends its reply with ONE block:
//
// ```browser
// {"tool":"click","ref":"e12","why":"opening the cart"}
// ```
//
// We execute the action and send the result back as a [BROWSER_RESULT] message.
//
// This file holds the AgentLoop orchestration; the system prompt lives in
// ./agent/preamble.js and reply parsing lives in ./agent/parse.js.

import { describeAction, isSensitiveAction } from "./tools.js";
import { BrowserWorker, DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY, MAX_SUBTASKS } from "./worker.js";
import { executeFanOut, normalizeSubtasks } from "./fanout.js";
import { getPreset } from "./providers.js";
import { buildPreamble } from "./agent/preamble.js";
import {
  READ_ONLY_TOOLS, PROGRESS_TOOLS, VERIFY_TOOLS,
  SPAWN_TOOLS, WORKER_TOOLS, DELEGATION_TOOLS,
  MAX_AUTO_RETRIES, MAX_VERIFY_NUDGES,
  endsWithQuestion, escapeForJson, actionSignature, parseAgentReply,
} from "./agent/parse.js";

export { buildPreamble, parseAgentReply };

export class AgentLoop {
  /**
   * @param {object} deps
   *  chat     – session interface: send({text, attachments}) → Promise<string|null>,
   *             cancel(), supportsAttachments(), sessionKey()
   *  tools    – BrowserTools (scope: this session's tab group)
   *  ui       – callbacks: addAssistant, addChip, requestApproval,
   *             setWorking, systemNote, addScreenshotThumb, setProgressLabel
   *  getSettings – () => current settings
   */
  constructor({ chat, tools, ui, getSettings }) {
    this.chat = chat;
    this.tools = tools;
    this.ui = ui;
    this.getSettings = getSettings;
    this.running = false;
    this.stopped = false;
    this.preambleSentFor = new Set(); // sessionKey → preamble already sent
    this.lastSnapshot = "";
    this.worker = null; // lazily created BrowserWorker (sequential delegation)
    this._activeWorkers = new Set(); // in-flight parallel workers (for stop propagation)
    this._nudgeCount = 0; // consecutive no-action replies nudged back to continue
    this._autoRetryCount = 0; // consecutive stale-ref auto-retries
    this._verifyNudgeCount = 0; // consecutive re-emits of a state-changing action without a "verify" field
    this._doneAttempts = 0; // how many times the model has emitted {"tool":"done"} this turn (guard against done-spam)
    this._lastActionSignature = null; // JSON signature of last action, to detect+break exact-repeat loops
    this._repeatCount = 0; // consecutive identical actions
    this.endReason = null; // why the last turn ended: done | ask | step-limit | stopped | no-reply | repeat-guard
  }

  stop() {
    this.stopped = true;
    this.endReason = "stopped";
    this.chat.cancel?.();
    // Also stop the sequential worker + any in-flight parallel workers.
    if (this.worker) this.worker.stop?.();
    for (const w of this._activeWorkers) { try { w.stop?.(); } catch { /* ignore */ } }
    this.setGlow(false);
  }

  async setGlow(on) {
    try { await this.tools.sendToContent("working_indicator", { on }); } catch { /* e.g. chrome:// */ }
  }

  markPreambleSent(sessionKey) { this.preambleSentFor.add(sessionKey); }

  /** Check if the current model supports vision (image attachments). */
  modelSupportsVision(settings) {
    if (settings.backendMode === "direct") {
      const preset = getPreset(settings.directProvider);
      return preset?.supportsVision ?? false;
    }
    // OpenClaw gateway — assume vision support (server handles it)
    return true;
  }

  /** Lazily create or reuse the BrowserWorker. */
  getWorker() {
    if (!this.worker) {
      this.worker = new BrowserWorker({
        tools: this.tools,
        getSettings: this.getSettings,
        onStep: (step, _body) => {
          this.ui.setWorking(true, `Worker step ${step + 1}…`);
        },
      });
    }
    return this.worker;
  }

  async buildContextHeader({ includePage, includeShot }) {
    const parts = [];
    const info = await this.tools.tabInfo();
    if (info.ok) parts.push(`[BROWSER_CONTEXT] Active tab: ${info.url} — "${info.title}"${info.restricted ? " (RESTRICTED — browser tools unavailable here)" : ""}`);
    else parts.push(`[BROWSER_CONTEXT] No active tab available.`);

    if (includePage && info.ok && !info.restricted) {
      const t = await this.tools.run({ tool: "get_text", maxChars: 16000 });
      if (t.ok) parts.push(`--- PAGE TEXT (${t.title}) ---\n${t.text}`);
      const s = await this.tools.run({ tool: "snapshot" });
      if (s.ok) { parts.push(`--- PAGE ELEMENTS ---\n${s.snapshot}`); this.lastSnapshot = s.snapshot; }
    }
    return parts.join("\n\n");
  }

  /** Main entry: user message. */
  async run(userText, { includePage = false, includeShot = false } = {}) {
    if (this.running) throw new Error("Agent is already working.");
    const settings = this.getSettings();
    this.running = true;
    this.stopped = false;
    this._nudgeCount = 0;
    this._autoRetryCount = 0;
    this._verifyNudgeCount = 0;
    this._doneAttempts = 0;
    this._lastActionSignature = null;
    this._repeatCount = 0;
    this._activeWorkers.clear();
    this.endReason = null;

    try {
      const sessionKey = this.chat.sessionKey();

      // Clear tool context from previous turn — old DOM snapshots and BROWSER_RESULTs
      // must NOT carry into the next turn. Permanent history is preserved separately.
      this.chat.resetTurn?.();

      // Preamble: for direct mode, send system message on EVERY call (stateless API).
      // For gateway mode, only send once (server is stateful).
      const isDirect = settings.backendMode === "direct";
      let systemMessage = null;
      if (isDirect || !this.preambleSentFor.has(sessionKey)) {
        systemMessage = buildPreamble(settings.assistantName, { supportsVision: this.modelSupportsVision(settings) });
        this.preambleSentFor.add(sessionKey);
      }

      // Build ephemeral context (page state, snapshots) — sent to LLM but NOT persisted in history
      const contextHeader = await this.buildContextHeader({ includePage, includeShot });
      let body = contextHeader + `\n\n[USER MESSAGE]\n${userText}`;

      let attachments = [];
      // Check if current model supports vision (image attachments)
      const canUseVision = this.modelSupportsVision(settings);
      if (includeShot && settings.allowScreenshots && canUseVision) {
        const shot = await this.tools.run({ tool: "screenshot" });
        if (shot.ok) {
          attachments.push({ dataUrl: shot.dataUrl, mimeType: "image/jpeg", name: "tab.jpg" });
          this.ui.addScreenshotThumb?.(shot.dataUrl);
        }
      }

      this.setGlow(true);
      await this.turnLoop(body, attachments, settings, systemMessage, userText);
    } finally {
      this.running = false;
      this.ui.setWorking(false);
      this.setGlow(false);
    }
  }

  // --------------------------------------------------------------- turn loop

  /** Persist whatever we have so far and return — used on every early-exit path. */
  finishTurn(userText, lastNarration) {
    if (userText) this.chat.storePermanent?.("user", userText);
    if (lastNarration) this.chat.storePermanent?.("assistant", lastNarration);
  }

  /** Build the "step N/maxSteps" working label and start the stall-detection heartbeat. */
  startHeartbeat(stepLabel) {
    const t0 = Date.now();
    this.chat.lastPartialAt = t0;
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const sincePartial = Math.round((Date.now() - (this.chat.lastPartialAt || t0)) / 1000);
      if (sincePartial < 5) {
        this.ui.setWorking(true, `${stepLabel} — LLM streaming…`);
      } else if (elapsed < 30) {
        this.ui.setWorking(true, `${stepLabel} — waiting for LLM… (${elapsed}s)`);
      } else {
        this.ui.setWorking(true, `${stepLabel} — ⚠️ LLM stalled ${sincePartial}s (no tokens)`);
      }
      // Warn user once if no activity for 30s
      if (sincePartial > 30 && !this._warnedStuck) {
        this._warnedStuck = true;
        this.ui.systemNote(`⚠️ No response from LLM for ${sincePartial}s. Click ■ stop or wait — the model may be overloaded.`);
      }
    }, 2000);
    return heartbeat;
  }

  /**
   * Loop: send → receive final → execute action → send result → …
   * All messages in the loop are ephemeral (not persisted in conversation history).
   * When the loop ends (agent responds without action), the clean user intent
   * and assistant narration are stored permanently.
   */
  async turnLoop(firstBody, firstAttachments, settings, systemMessage = null, userText = "") {
    let body = firstBody;
    let attachments = firstAttachments || [];
    let step = 0;
    let lastNarration = ""; // track narration across steps for permanent storage on early exit
    const maxSteps = Math.max(1, Number(settings.maxSteps) || 200);

    while (true) {
      if (this.stopped) return this.finishTurn(userText, lastNarration);

      const stepLabel = step === 0 ? `${settings.assistantName} is thinking…` : `${settings.assistantName} is working… (step ${step}/${maxSteps})`;
      this.ui.setWorking(true, stepLabel);

      const heartbeat = this.startHeartbeat(stepLabel);
      let reply;
      try {
        // All agent loop messages are ephemeral — they carry DOM snapshots and BROWSER_RESULTs
        // that should NOT pollute the permanent conversation history.
        reply = await this.chat.send({ text: body, attachments, systemMessage, ephemeral: true });
      } finally {
        clearInterval(heartbeat);
        this._warnedStuck = false;
      }
      if (this.stopped) return this.finishTurn(userText, lastNarration);
      if (reply == null) { this.endReason = "no-reply"; this.ui.systemNote("No response received (timeout)."); return; }

      // Check stop again — LLM may have finished streaming but we pressed stop during it
      if (this.stopped) return this.finishTurn(userText, lastNarration);

      // Count this LLM round-trip against the step budget. We increment here (before
      // parsing) so that EVERY path — no-action nudges, verification rejects, progress
      // updates — is bounded by maxSteps. Previously only executed browser actions
      // consumed steps, which meant nudge loops could run unbounded. Now the hard cap
      // is a true safety bound on total iterations.
      step++;
      if (step > maxSteps) {
        this.endReason = "step-limit";
        this.ui.systemNote(`Reached the safety bound of ${maxSteps} steps — stopping the loop to avoid running forever. Re-send your message to continue with a fresh budget.`);
        this.finishTurn(userText, lastNarration && `[Stopped at step limit] ${lastNarration}`);
        return;
      }

      const parsed = parseAgentReply(reply);
      if (parsed.narration) { this.ui.addAssistant(parsed.narration); lastNarration = parsed.narration; }

      if (!parsed.action) {
        const outcome = await this.handleNoAction(parsed, settings, lastNarration, userText);
        if (outcome.done) return;
        lastNarration = outcome.lastNarration;
        body = outcome.body;
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // A real action arrived — reset the no-action nudge streak.
      this._nudgeCount = 0;
      const action = parsed.action;

      // MID-TASK RECAP: Every 10 steps, inject a reminder of what was done and what's left.
      // This prevents LLM from losing context on long multi-item tasks.
      if (step > 0 && step % 10 === 0) {
        body = `[MID-TASK CHECKPOINT] You are at step ${step}/${maxSteps}.\nBefore your next action, briefly recap:\n1. What you have completed so far (with checkmarks ✅)\n2. What still needs to be done\n3. What your next action is\nKeep it to 2-3 lines, then continue with the next action. Do NOT emit {"tool":"done"} while any item is still pending.\n\n${body}`;
      }

      // --- LIVE PROGRESS TOOL (non-loop-ending) ---
      if (PROGRESS_TOOLS.has(action.tool)) {
        body = this.handleProgressTool(action);
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- SELF-VERIFICATION CHECKPOINT TOOL (non-loop-ending) ---
      if (VERIFY_TOOLS.has(action.tool)) {
        body = await this.handleVerifyTool();
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- PER-ACTION SELF-VERIFICATION FIELD CHECK ---
      const verifyNudge = this.checkVerifyField(action, settings);
      if (verifyNudge) {
        body = verifyNudge;
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- REPEAT-GUARD: detect the exact same action emitted repeatedly ---
      const repeatNudge = this.checkRepeatGuard(action, settings);
      if (repeatNudge) {
        body = repeatNudge;
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- parallel fan-out (own tab + own sub-agent per subtask, run concurrently) ---
      if (SPAWN_TOOLS.has(action.tool)) {
        if (this.stopped) return this.finishTurn(userText, lastNarration);
        body = await this.handleSpawnWorkers(action, settings);
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- sequential single-worker delegation (intercept before approval gate) ---
      if (WORKER_TOOLS.has(action.tool)) {
        if (this.stopped) return this.finishTurn(userText, lastNarration);
        body = await this.handleWorkerDelegation(action, settings);
        attachments = [];
        if (settings.backendMode !== "direct") systemMessage = null;
        continue;
      }

      // --- user approval + execution ---
      const stepResult = await this.executeAction(action, settings, stepLabel);
      if (this.stopped) return this.finishTurn(userText, lastNarration);

      body = stepResult.body;
      attachments = stepResult.attachments;
      if (stepResult.contextAppend) body += stepResult.contextAppend;

      // systemMessage stays constant across all steps in direct mode (stable prefix for caching)
      // Only null it for gateway mode (stateful server has it from first call)
      if (settings.backendMode !== "direct") systemMessage = null;
    }
  }

  /**
   * Handle a reply with NO browser action. This is AMBIGUOUS — it can mean:
   *  (a) genuinely done       → the model emitted {"tool":"done"}
   *  (b) asking the user      → {"tool":"ask"} or a trailing question
   *  (c) forgot the block     → mid-task, just narrated (the classic premature-stop)
   *  (d) malformed JSON block → parse failed
   * Only (a)/(b) legitimately end the loop. For (c)/(d) we NUDGE to continue,
   * otherwise long multi-item tasks terminate at the first stray reply.
   * Returns { done: true } if the turn ended, otherwise { done: false, body, lastNarration }.
   */
  async handleNoAction({ narration, control, controlObj, hadBlock }, settings, lastNarration, userText) {
    const isDone = control === "done";
    const isAsk = control === "ask" || (!hadBlock && endsWithQuestion(narration));

    if (isDone) {
      const result = this.handleDoneAttempt(narration, controlObj, settings, lastNarration);
      if (result.finished) {
        this.finishTurn(userText, result.lastNarration);
        return { done: true };
      }
      return { done: false, body: result.body, lastNarration: result.lastNarration };
    }

    if (isAsk) {
      this.endReason = "ask";
      const finalText = narration || (controlObj && controlObj.question) || "";
      if (finalText && finalText !== lastNarration) { this.ui.addAssistant(finalText); lastNarration = finalText; }
      this._nudgeCount = 0;
      this.finishTurn(userText, lastNarration);
      return { done: true };
    }

    // (c)/(d): premature stop or malformed block. NEVER ask the user "continue?"
    // — just nudge harder and keep going. Nudge strength escalates with the streak
    // so a stubborn model eventually complies or hits the hard step cap.
    this._nudgeCount++;
    if (settings.debug) this.ui.systemNote(`🔄 No action block — auto-continuing (nudge ${this._nudgeCount}).`);
    const strength = this._nudgeCount;
    const nudge = hadBlock
      ? `Your last reply contained a code block but its JSON could not be parsed (malformed action). Re-send ONE valid \`browser\` action block, e.g. {"tool":"click","ref":"ref_12","verify":"…"}.`
      : (strength <= 2
          ? `Your last reply had NO \`browser\` action block. Re-read your checklist: if ANY item is still pending, CONTINUE NOW with the next browser action — do not stop early. If EVERY item is truly complete and verified, reply with {"tool":"done","summary":"…","verified":true}.`
          : `STOP NARRATING. You must end your reply with exactly ONE \`browser\` action block (e.g. {"tool":"snapshot"}) OR a verified done/ask control block. Plain narration with no block is not allowed mid-task. Emit the next action block NOW.`);
    const body = `[BROWSER_RESULT] {"ok":false,"error":"no_action"}\n[SYSTEM] ${nudge}`;
    return { done: false, body, lastNarration };
  }

  /**
   * ---- FINAL VERIFICATION GATE ----
   * The model wants to finish. Before accepting, require it to have run a
   * verification pass (snapshot relevant pages, walk the checklist with
   * evidence). It signals this with "verified":true on the done block.
   * Without it, we REJECT the done and send the model back to verify —
   * this is the "verify final result" step. After a few attempts without
   * verification (non-compliant model), accept anyway for robustness.
   */
  handleDoneAttempt(narration, controlObj, settings, lastNarration) {
    this._doneAttempts++;
    const verified = !!(controlObj && (controlObj.verified === true || controlObj.verified === "true"));
    if (verified || this._doneAttempts >= 3) {
      this.endReason = "done";
      const summary = (controlObj && controlObj.summary) || "";
      const finalText = narration || summary || "Done.";
      if (finalText && finalText !== lastNarration) { this.ui.addAssistant(finalText); lastNarration = finalText; }
      this._nudgeCount = 0;
      this._doneAttempts = 0;
      if (!verified) {
        this.ui.systemNote(`${settings.assistantName} finished without explicit verification — recommend reviewing the result.`);
      }
      return { finished: true, lastNarration };
    }
    // Reject: send the model back to VERIFY before finishing.
    if (settings.debug) this.ui.systemNote(`🔎 done received without "verified":true — sending back to verify (attempt ${this._doneAttempts}/3).`);
    const body = `[SYSTEM] You emitted {"tool":"done"} but did NOT verify the final result. Before finishing you MUST run a verification pass:
1. Snapshot every page where the outcome should be visible (cart, order summary, confirmation screen, etc.).
2. Walk through your original checklist item by item.
3. For EACH item, cite concrete evidence from the snapshot that it is complete (e.g. "item 1: red shirt qty 1 visible in cart row 2").
4. Only if EVERY item is confirmed, re-emit {"tool":"done","summary":"…","verified":true} with your verification notes in the summary.
5. If ANY item is NOT confirmed, do NOT emit done — keep working on the incomplete item right now.

Begin the verification pass now with a {"tool":"snapshot"} (or navigate to the relevant page first).`;
    return { finished: false, body, lastNarration };
  }

  /**
   * {"tool":"progress","label":"Adding item 3/5"} updates the tab-group title
   * with a short LLM-generated label of the current sub-task, then continues.
   */
  handleProgressTool(action) {
    const label = action.label || action.title || action.text || "";
    if (label) this.ui.setProgressLabel?.(label);
    // Acknowledge and ask for the next real action immediately — do not burn a step counter.
    return `[BROWSER_RESULT] {"tool":"progress","ok":true,"label":"${escapeForJson(label)}"}\n[SYSTEM] Progress label applied. Now emit your next browser action (or a verified done).`;
  }

  /**
   * {"tool":"verify"} or {"tool":"checkpoint"} — the model proactively wants to
   * re-confirm state. Inject a fresh snapshot so it can verify, then continue.
   */
  async handleVerifyTool() {
    let snapSection = "";
    try {
      const snap = await this.tools.run({ tool: "snapshot" });
      if (snap.ok && snap.snapshot) {
        this.lastSnapshot = snap.snapshot;
        let snapStr = snap.snapshot;
        if (snapStr.length > 12000) snapStr = snapStr.slice(0, 12000) + "…(truncated)";
        snapSection = `\n--- PAGE ELEMENTS (verification snapshot) ---\n${snapStr}`;
      }
    } catch (e) { snapSection = `\n[NOTE] Verification snapshot failed: ${e.message}`; }
    return `[BROWSER_RESULT] {"tool":"verify","ok":true}${snapSection}\n[SYSTEM] Fresh snapshot provided for your verification. Confirm your checklist state against it, then emit the next action (or a verified done).`;
  }

  /**
   * The model is required to confirm each state-changing action with a "verify"
   * field citing snapshot evidence. If missing, send it back to re-emit WITH
   * verification — this is the "LLM confirms all actions" mechanism. After a
   * couple of re-emits without the field (non-compliant model), give up and
   * execute anyway so we don't deadlock. Returns a nudge body, or null to proceed.
   */
  checkVerifyField(action, settings) {
    const isStateChanging = !READ_ONLY_TOOLS.has(action.tool)
      && !DELEGATION_TOOLS.has(action.tool);
    if (!isStateChanging) return null;

    if (!action.verify && this._verifyNudgeCount < MAX_VERIFY_NUDGES) {
      this._verifyNudgeCount++;
      if (settings.debug) this.ui.systemNote(`🔎 Action without "verify" field — asking model to confirm (${this._verifyNudgeCount}/${MAX_VERIFY_NUDGES}).`);
      return `[SYSTEM] You emitted {"tool":"${action.tool}"} without a "verify" field. Before executing a state-changing action you MUST confirm it with concrete evidence from your most recent snapshot. Re-emit the SAME action with a "verify" field, e.g.:\n{"tool":"${action.tool}","ref":"${action.ref || ""}","why":"…","verify":"ref_X = [element description] from snapshot, on page Y because Z"}\nIf you don't have a fresh snapshot, emit {"tool":"snapshot"} first.`;
    }
    this._verifyNudgeCount = 0;
    return null;
  }

  /**
   * Detect the exact same action emitted repeatedly (a common failure mode:
   * model keeps clicking the same stale ref). Break the loop by forcing a
   * fresh snapshot + a demand for a different approach. Returns a nudge body,
   * or null to proceed with execution.
   */
  checkRepeatGuard(action, settings) {
    const sig = actionSignature(action);
    if (!sig || sig !== this._lastActionSignature) {
      this._repeatCount = 0;
      this._lastActionSignature = sig;
      return null;
    }
    this._repeatCount++;
    if (this._repeatCount < 3) return null;

    if (settings.debug) this.ui.systemNote(`🔁 Detected same action ×${this._repeatCount} — forcing a different approach.`);
    this._repeatCount = 0;
    this._lastActionSignature = null;
    return `[SYSTEM] You just emitted the EXACT same action (${sig}) for the 3rd time in a row. Repeating it will not help. Instead:\n1. {"tool":"snapshot"} to get fresh refs.\n2. Read the actual page state — maybe the action already succeeded, or the element changed.\n3. Try a GENUINELY DIFFERENT approach (different ref, scroll, navigate, search, etc.).\nDo NOT re-emit the identical action.`;
  }

  /** Delegate a {"tool":"multi_step"|"quick_action"} to the BrowserWorker sub-agent. */
  async handleWorkerDelegation(action, settings) {
    const isMulti = action.tool === "multi_step";
    const taskText = isMulti ? (action.goal || action.intent || action.text || "") : (action.intent || action.text || "");
    if (!taskText) {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"No goal/intent provided."}`;
    }
    const chip = this.ui.addChip(isMulti ? `🤖 Worker: ${taskText.slice(0, 50)}` : `⚡ Quick: ${taskText.slice(0, 50)}`, action.why);
    let body;
    try {
      this.ui.setWorking(true, isMulti ? `Worker: ${taskText.slice(0, 60)}…` : `Quick action…`);
      const worker = this.getWorker();
      const report = await worker.execute(taskText, {
        approvalGate: async (wAction) => this.approvalGate(wAction, settings),
      });
      const workerDetail = report.summary || (report.success ? "ok" : "failed");
      const workerFullError = report.success ? null
        : `Worker task failed.\n\nGoal: ${taskText}\n\nResult: ${workerDetail}${report.observations?.length ? "\n\nObservations:\n" + report.observations.map(o => "• " + o).join("\n") : ""}`;
      chip.setResult(report.success, report.success ? "ok" : "failed", workerFullError);
      // Format worker report for planner
      let reportStr = `{"tool":"${action.tool}","ok":${report.success},"summary":"${escapeForJson(report.summary || "")}"`;
      if (report.observations && report.observations.length) {
        reportStr += `,"observations":[${report.observations.map(o => `"${escapeForJson(o)}"`).join(",")}]`;
      }
      reportStr += `}`;
      body = `[BROWSER_RESULT] ${reportStr}`;
    } catch (e) {
      chip.setResult(false, e.message);
      body = `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"${escapeForJson(e.message)}"}`;
    }
    // Worker may have changed the page — add tab context
    const info2 = await this.tools.tabInfo();
    if (info2.ok) body += `\n[TAB] ${info2.url} — "${info2.title}"`;
    return body;
  }

  /**
   * PARALLEL FAN-OUT. Delegate N independent sub-tasks, each to its own
   * BrowserWorker running in its own background tab, concurrently (bounded by a
   * semaphore). Each worker gets an isolated, tab-pinned BrowserTools view via
   * scopedTo() so lanes never step on each other. Results are aggregated into
   * ONE compact [BROWSER_RESULT] so the planner's context stays small.
   *
   * Workers auto-run non-sensitive browsing and deny sensitive actions
   * (payments, credentials) — the planner performs those itself, sequentially,
   * after aggregating. This avoids approval-dialog contention (the single
   * pendingApproval slot can't be shared by N parallel workers).
   *
   * Worker tabs are closed after completion — the compressed report is
   * returned to the planner, so the tabs are no longer needed.
   */
  async handleSpawnWorkers(action, settings) {
    const subtasks = normalizeSubtasks(action);
    if (!subtasks.length) {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"No subtasks provided. Use {\\"tool\\":\\"fan_out\\",\\"tasks\\":[{\\"goal\\":\\"…\\",\\"url\\":\\"…optional\\"}]}."}`;
    }

    // Workers use DirectBackend — require a direct provider API key
    const s = this.getSettings();
    const hasDirectKey = s.providerKeys && Object.values(s.providerKeys).some((k) => k);
    if (!hasDirectKey) {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"No direct provider API key configured. Fan-out requires a direct LLM provider key for workers. Add one in ⚙ Settings → Models & keys."}`;
    }

    if (subtasks.length > MAX_SUBTASKS) {
      this.ui.systemNote(`⚠️ ${subtasks.length} subtasks requested — running the first ${MAX_SUBTASKS}. Re-run for the rest.`);
      subtasks.length = MAX_SUBTASKS;
    }

    // Batch approval for the entire fan-out plan (one approval, not N)
    const fanOutApproved = await this.approveFanOut(subtasks, action.why);
    if (this.stopped) return "";
    if (fanOutApproved === "deny") {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"User denied the fan-out plan."}`;
    }

    const total = subtasks.length;
    this.ui.setProgressLabel?.(`fan-out: 0/${total}`);
    this.ui.systemNote(`🧵 Spawning ${total} parallel worker${total === 1 ? "" : "s"}. Workers browse read-only; sensitive actions stay with me.`);

    // One chip per subtask for live per-task visibility.
    const chips = subtasks.map((sub, i) =>
      this.ui.addChip(`🧵 [${i + 1}/${total}] ${String(sub.goal).slice(0, 46)}`, sub.url || "")
    );
    const results = new Array(total);
    let completed = 0;

    const reports = await executeFanOut({
      tasks: subtasks,
      tools: this.tools,
      getSettings: this.getSettings,
      approvalGate: null, // fanout.js uses deny-sensitive gate internally
      isStopped: () => this.stopped,
      onProgress: (index, totalT, label) => {
        this.ui.setWorking(true, `worker ${index + 1}/${totalT}: ${label} (${completed}/${totalT} done)`);
      },
      onWorkerStart: (index, totalT, _tabId) => {
        if (settings.debug) this.ui.systemNote(`🔄 Worker ${index + 1}/${totalT} started`);
      },
      onWorkerComplete: (index, _totalT, report) => {
        results[index] = { goal: subtasks[index].goal, ...report };
        completed++;
        const note = report.success
          ? String(report.summary || "ok").slice(0, 60)
          : String(report.summary || "failed").slice(0, 80);
        chips[index].setResult(
          !!report.success, note,
          report.success ? null : `Task: ${subtasks[index].goal}\n\n${report.summary || "failed"}`
        );
        // Surface failed worker reasons as system notes so the user can see
        // WHY a worker failed (not just "failed" on the chip).
        if (!report.success) {
          const reason = String(report.summary || "unknown error").slice(0, 120);
          this.ui.systemNote(`⚠️ Worker ${index + 1}/${_totalT} failed: ${reason}`);
        }
        this.ui.setProgressLabel?.(`fan-out: ${completed}/${total} done`);
      },
      depth: 0,
      why: action.why || "",
    });

    // Any slot left unrun (user stopped mid-batch) → mark it so aggregation is complete.
    for (let i = 0; i < total; i++) {
      if (!results[i]) {
        results[i] = { goal: subtasks[i].goal, success: false, summary: "not run (stopped)", data: null };
        chips[i].setResult(false, "skipped");
      }
    }

    return this.buildFanOutReport(action.tool, results);
  }

  /** Aggregate parallel-worker results into one compact [BROWSER_RESULT] for the planner. */
  buildFanOutReport(tool, results) {
    const succeeded = results.filter(r => r.success).length;
    const compact = results.map(r => {
      const o = {
        goal: String(r.goal || "").slice(0, 140),
        success: !!r.success,
        summary: String(r.summary || "").slice(0, 300),
      };
      if (r.data && typeof r.data === "object") o.data = r.data;
      if (Array.isArray(r.observations) && r.observations.length) o.observations = r.observations.slice(0, 5);
      return o;
    });
    const payload = { tool, ok: succeeded > 0, total: results.length, succeeded, failed: results.length - succeeded, results: compact };
    let str;
    try { str = JSON.stringify(payload); }
    catch { str = JSON.stringify({ tool, ok: true, total: results.length, succeeded, note: "results omitted (serialize error)" }); }
    if (str.length > 40000) str = str.slice(0, 40000) + "…(truncated)";

    return `[BROWSER_RESULT] ${str}\n[SYSTEM] All ${results.length} parallel workers finished (${succeeded} succeeded, ${results.length - succeeded} failed). Worker tabs have been closed.\nAggregate/compare these results and continue the task — or, if everything is done, run your final verification and emit {"tool":"done","verified":true}.`;
  }

  /**
   * Batch approval for a fan-out plan. Shows the list of tasks and asks once.
   * If autopilot is enabled for the current site, auto-approves.
   * Returns "run" | "deny".
   */
  async approveFanOut(subtasks, why) {
    const info = await this.tools.tabInfo();
    let origin = "";
    try { origin = new URL(info.url || "").origin; } catch { /* chrome:// etc. */ }

    const fresh = this.getSettings();
    const hasSiteList = fresh.allowedSites && fresh.allowedSites.length > 0;
    const autopilot = fresh.actionMode === "auto" && origin && (!hasSiteList || fresh.allowedSites.includes(origin));

    if (autopilot) return "run";

    const taskList = subtasks.slice(0, 8).map((s, i) => `${i + 1}. ${s.goal}`).join("\n");
    const more = subtasks.length > 8 ? `\n... and ${subtasks.length - 8} more` : "";

    const answer = await this.ui.requestApproval({
      description: `🧵 Fan-out: ${subtasks.length} parallel task${subtasks.length > 1 ? "s" : ""}\n${taskList}${more}`,
      why: why || "Parallel sub-task execution",
      origin,
      sensitive: false,
    });

    if (this.stopped) return "deny";
    if (answer === "always" && origin) {
      const sites = new Set(fresh.allowedSites);
      sites.add(origin);
      await chrome.storage.local.set({ allowedSites: [...sites], actionMode: "auto" });
      return "run";
    }
    return answer === "yes" ? "run" : "deny";
  }

  /**
   * Run the approval gate then execute a real browser action, handling
   * auto-retry on stale refs, screenshot attachments, and post-action context
   * (tab info / auto-snapshot after page-changing actions).
   * Returns { body, attachments, contextAppend }.
   */
  async executeAction(action, settings, stepLabel) {
    const decision = await this.approvalGate(action, settings);
    if (this.stopped) return { body: "", attachments: [], contextAppend: "" };

    let result;
    const chip = this.ui.addChip(describeAction(action), action.why);
    const actionJson = JSON.stringify(action, null, 2);
    const actionStart = Date.now();
    if (decision === "deny") {
      chip.setResult(false, "denied", `Action denied by user.\n\nAction:\n${actionJson}`);
      result = { ok: false, error: "User denied this action. Ask them how to proceed or finish." };
    } else {
      this.ui.setWorking(true, `${stepLabel} — executing ${action.tool}…`);
      result = await this.tools.run(action);
      const actionMs = Date.now() - actionStart;
      if (action.tool === "snapshot" && result.ok) this.lastSnapshot = result.snapshot;
      const errMsg = result.ok !== false ? "ok" : (result.error || "error");
      const timingNote = actionMs > 2000 ? ` (${(actionMs/1000).toFixed(1)}s)` : "";
      const fullErr = result.ok === false
        ? `Action failed.${timingNote}\n\nAction:\n${actionJson}\n\nError:\n${result.error || "unknown"}`
        : null;
      chip.setResult(result.ok !== false, errMsg + timingNote, fullErr);
      if (settings.debug) {
        this.ui.systemNote(`⏱️ ${action.tool}: ${actionMs}ms ${result.ok !== false ? "ok" : "fail"}`);
      }

      result = await this.maybeAutoRetry(action, result, settings);
    }
    if (this.stopped) return { body: "", attachments: [], contextAppend: "" };

    const { body, attachments } = this.buildResultMessage(action, result, settings);
    const contextAppend = await this.buildPostActionContext(action);
    return { body, attachments, contextAppend };
  }

  /**
   * AUTO-RETRY: If click/fill failed with "not found" or stale ref,
   * automatically snapshot and provide fresh refs for retry (like OpenClaw).
   * Allow several consecutive assists (persistence) before giving up.
   */
  async maybeAutoRetry(action, result, settings) {
    if (result.ok === false && ["click", "fill"].includes(action.tool)) {
      const isStaleRef = /not found|stale|undefined/i.test(result.error || "");
      if (isStaleRef && this._autoRetryCount < MAX_AUTO_RETRIES) {
        this._autoRetryCount++;
        if (settings.debug) this.ui.systemNote(`🔄 Auto-retry ${this._autoRetryCount}/${MAX_AUTO_RETRIES}: ref stale, fetching fresh snapshot…`);
        try {
          const freshSnap = await this.tools.run({ tool: "snapshot" });
          if (freshSnap.ok && freshSnap.snapshot) {
            this.lastSnapshot = freshSnap.snapshot;
            // Prepend hint to result so LLM knows to retry with new ref
            return {
              ...result,
              error: `${result.error}\n\n[AUTO-RETRY] The ref was stale. I fetched a fresh snapshot. Use the new refs below and retry with the correct "ref" value (e.g. {"tool":"click","ref":"ref_15"}).`,
              _autoRetrySnapshot: freshSnap.snapshot,
            };
          }
        } catch { /* snapshot failed, continue normally */ }
      }
    } else {
      // Successful action, or a non-click/fill action → reset the stale-ref streak.
      this._autoRetryCount = 0;
    }
    return result;
  }

  /** Build the [BROWSER_RESULT] message body (+attachments) sent back to the LLM. */
  buildResultMessage(action, result, settings) {
    const canVision = this.modelSupportsVision(settings);
    const attachments = [];
    let body;
    if (action.tool === "screenshot" && result.ok && settings.allowScreenshots && canVision && this.chat.supportsAttachments()) {
      attachments.push({ dataUrl: result.dataUrl, mimeType: "image/jpeg", name: "screenshot.jpg" });
      this.ui.addScreenshotThumb?.(result.dataUrl);
      body = `[BROWSER_RESULT] ${JSON.stringify({ tool: "screenshot", ok: true, width: result.width, height: result.height })} (image attached)`;
    } else if (action.tool === "screenshot" && result.ok && !canVision) {
      // Model doesn't support images — convert screenshot to text description
      this.ui.addScreenshotThumb?.(result.dataUrl);
      body = `[BROWSER_RESULT] {"tool":"screenshot","ok":false,"error":"This model does not support image attachments. Use snapshot or get_text instead to read the page."}`;
    } else if (action.tool === "screenshot" && result.ok) {
      this.ui.addScreenshotThumb?.(result.dataUrl);
      body = `[BROWSER_RESULT] {"tool":"screenshot","ok":false,"error":"Gateway does not accept image attachments — use snapshot/get_text instead."}`;
    } else {
      const compact = { tool: action.tool, ...result };
      // Remove internal fields not meant for LLM
      delete compact._autoRetrySnapshot;
      // snapshot/get_text can be long — send in full, but don't duplicate fields
      let payload = JSON.stringify(compact);
      if (payload.length > 30000) payload = payload.slice(0, 30000) + "…(truncated)";
      body = `[BROWSER_RESULT] ${payload}`;
      // If auto-retry snapshot was taken, append fresh refs for LLM
      if (result._autoRetrySnapshot) {
        let snapStr = result._autoRetrySnapshot;
        if (snapStr.length > 12000) snapStr = snapStr.slice(0, 12000) + "…(truncated)";
        body += `\n--- PAGE ELEMENTS (fresh snapshot for retry) ---\n${snapStr}`;
      }
    }
    return { body, attachments };
  }

  /**
   * After page-changing actions, add fresh tab info + auto-snapshot so the
   * agent immediately sees the new page (fixes the "stuck after navigate" bug).
   * Returns a string to append to the result body (may be empty).
   */
  async buildPostActionContext(action) {
    if (!["click", "navigate", "back", "new_tab", "press", "fill", "switch_tab"].includes(action.tool)) return "";

    let append = "";
    // Clicks that open new tabs need more time for the tab to be created and start loading
    const waitMs = action.tool === "click" ? 1200 : 800;
    await new Promise(r => setTimeout(r, waitMs));

    if (action.tool === "switch_tab") {
      const info2 = await this.tools.tabInfo();
      if (info2.ok) append += `\n[BROWSER_CONTEXT] Switched to tab: ${info2.url} — "${info2.title}".`;
    } else if (action.tool === "click") {
      // Detect if a click opened a new tab in the group (target=_blank, etc)
      const tabsInfo = await this.tools.tabInfo();
      if (tabsInfo.ok && tabsInfo.groupTabs) {
        const totalTabs = tabsInfo.groupTabs.length;
        const currentTab = tabsInfo.groupTabs.find(t => t.current);
        if (totalTabs > 1) {
          append += `\n[BROWSER_CONTEXT] The group has ${totalTabs} tabs:`;
          for (const t of tabsInfo.groupTabs) {
            append += `\n  ${t.current ? "→ ACTIVE" : "  "} ${t.url} — "${t.title}"`;
          }
          if (currentTab) append += `\nThe click opened/navigated to a different tab. Use snapshot to see the new page.`;
        } else if (currentTab) {
          append += `\n[BROWSER_CONTEXT] Tab now: ${currentTab.url} — "${currentTab.title}"`;
        }
      }
    } else {
      // navigate, back, new_tab, press, fill
      const info2 = await this.tools.tabInfo();
      if (info2.ok) append += `\n[BROWSER_CONTEXT] Tab now: ${info2.url} — "${info2.title}"`;
    }

    // Auto-snapshot after navigation so the agent immediately sees the new page
    if (!["fill", "press"].includes(action.tool)) {
      try {
        const snap = await this.tools.run({ tool: "snapshot" });
        if (snap.ok && snap.snapshot) {
          this.lastSnapshot = snap.snapshot;
          let snapStr = snap.snapshot;
          if (snapStr.length > 12000) snapStr = snapStr.slice(0, 12000) + "…(truncated)";
          append += `\n--- PAGE ELEMENTS (auto-snapshot after navigation) ---\n${snapStr}`;
        }
      } catch (e) {
        append += `\n[NOTE] Auto-snapshot failed: ${e.message}. You may need to wait and snapshot manually.`;
      }
    }
    this.setGlow(true);
    return append;
  }

  /** Returns "run" | "deny". Asks the user if needed. */
  async approvalGate(action, settings) {
    if (READ_ONLY_TOOLS.has(action.tool)) return "run";

    const info = await this.tools.tabInfo();
    let origin = "";
    try { origin = new URL(info.url || "").origin; } catch { /* none */ }

    const fresh = this.getSettings();
    const sensitive = isSensitiveAction(action, this.lastSnapshot);

    // Autopilot logic:
    // - If actionMode is "auto" AND the site is in allowedSites → auto-approve (unless sensitive)
    // - If actionMode is "auto" AND no allowedSites defined yet → auto-approve ALL non-sensitive actions
    //   (user picked "autopilot" globally — treat as trust-all unless they've started
    //   narrowing down to specific sites)
    const hasSiteList = fresh.allowedSites && fresh.allowedSites.length > 0;
    const autopilot = fresh.actionMode === "auto" && origin && (!hasSiteList || fresh.allowedSites.includes(origin));

    if (autopilot && !sensitive) return "run";

    const answer = await this.ui.requestApproval({
      description: describeAction(action),
      why: action.why,
      origin,
      sensitive,
    });
    if (this.stopped) return "deny";
    if (answer === "always" && origin) {
      const sites = new Set(fresh.allowedSites); sites.add(origin);
      await chrome.storage.local.set({ allowedSites: [...sites], actionMode: "auto" });
      return "run";
    }
    return answer === "yes" ? "run" : "deny";
  }
}
