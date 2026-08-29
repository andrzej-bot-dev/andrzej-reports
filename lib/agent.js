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
import { getPreset } from "./providers.js";
import { buildPreamble } from "./agent/preamble.js";
import {
  READ_ONLY_TOOLS, PROGRESS_TOOLS, VERIFY_TOOLS,
  SPAWN_TOOLS, WORKER_TOOLS, DELEGATION_TOOLS,
  MAX_AUTO_RETRIES, MAX_VERIFY_NUDGES,
  endsWithQuestion, escapeForJson, actionSignature, parseAgentReply,
} from "./agent/parse.js";
import {
  markSection, stripBulkySections, diffSnapshots, safeJsonStringify,
  estimateTokens, isContextOverflowError,
} from "./agent/context.js";

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
    this._prevSnap = null; // last snapshot TEXT sent to the model (diff base) — reset on compaction
    this._ledger = []; // compact one-line log of every executed action (compaction recap source)
    this._lastProgressLabel = ""; // last {"tool":"progress"} label (compaction recap)
    this._compactRetries = 0; // context-overflow compaction retries this turn
    this._turnUserText = ""; // original user request of the current turn (compaction recap)
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
      if (t.ok) parts.push(markSection("PAGE TEXT", `(${t.title})\n${t.text}`));
      const s = await this.tools.run({ tool: "snapshot" });
      if (s.ok) { this.lastSnapshot = s.snapshot; parts.push(this.renderSnapshot(s.snapshot)); }
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
    this._prevSnap = null;
    this._ledger = [];
    this._lastProgressLabel = "";
    this._compactRetries = 0;
    this._turnUserText = userText;
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

      // MID-TASK RECAP: every 10 round-trips, remind the model to re-read its
      // checklist. Injected HERE (right before the send) so it actually reaches
      // the model — `body` is final for this round-trip at this point.
      if (step > 0 && step % 10 === 0) {
        body = `[MID-TASK CHECKPOINT] You are at step ${step}/${maxSteps}.\nBefore your next action, briefly recap:\n1. What you have completed so far (with checkmarks ✅)\n2. What still needs to be done\n3. What your next action is\nKeep it to 2-3 lines, then continue with the next action. Do NOT emit {"tool":"done"} while any item is still pending.\n\n${body}`;
      }

      // CONTEXT GUARD: when the accumulated context nears the model's window,
      // compact the turn (drop old tool results, inject a task recap + fresh
      // snapshot) BEFORE the request fails.
      body = await this.maybeCompactContext(body, settings);

      const heartbeat = this.startHeartbeat(stepLabel);
      let reply;
      try {
        // All agent loop messages are ephemeral — they carry DOM snapshots and BROWSER_RESULTs
        // that should NOT pollute the permanent conversation history.
        reply = await this.chat.send({ text: body, attachments, systemMessage, ephemeral: true });
      } catch (e) {
        // Provider says the request exceeded the context window (estimate was
        // off, or no usage data yet) — compact and retry instead of dying.
        if (isContextOverflowError(e?.message) && this.chat.canCompact?.() && this._compactRetries < 2) {
          this._compactRetries++;
          body = await this.maybeCompactContext(body, settings, { force: true });
          attachments = [];
          continue;
        }
        throw e;
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

      // The request landed — a later overflow is a NEW incident, so the forced-
      // compaction retry budget starts fresh (it only bounds retries within one
      // failing send, not across a long turn).
      this._compactRetries = 0;

      if (settings.debug) {
        const u = this.chat.usage?.();
        if (u) this.ui.systemNote(`📊 tokens: in ${u.input || 0}${u.cacheRead ? ` (+${u.cacheRead} cached)` : ""}${u.cacheWrite ? ` (+${u.cacheWrite} cache-write)` : ""}, out ${u.output || 0}`);
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
    if (label) {
      this.ui.setProgressLabel?.(label);
      this._lastProgressLabel = label;
      this._ledger.push(`— progress: ${label.slice(0, 60)}`);
    }
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
        snapSection = `\n` + this.renderSnapshot(snap.snapshot, {});
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
        approvalGate: async (wAction, wSnapshot) => this.approvalGate(wAction, settings, wSnapshot),
      });
      this._ledger.push(`worker "${taskText.slice(0, 60)}" → ${report.success ? "ok" : "FAIL"}: ${String(report.summary || "").split("\n")[0].slice(0, 80)}`);
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
   * lane pool). Each worker gets an isolated, tab-pinned BrowserTools view so
   * lanes never step on each other. Results are aggregated into ONE compact
   * [BROWSER_RESULT] so the planner's context stays small.
   *
   * Workers here are READ-ONLY researchers: navigation/reads auto-run, but
   * sensitive actions (payments, credentials) are denied — the planner performs
   * those itself, sequentially, after aggregating.
   */
  async handleSpawnWorkers(action, settings) {
    const subtasks = normalizeSubtasks(action);
    if (!subtasks.length) {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"No subtasks provided. Use {\\"tool\\":\\"spawn_workers\\",\\"subtasks\\":[{\\"goal\\":\\"…\\",\\"url\\":\\"…optional\\"}]}."}`;
    }

    // Parallel workers each run on a DirectBackend. Without a direct provider
    // AND an API key for it they'd all fail — bail early with guidance instead
    // of opening tabs that can't do anything.
    const workersAvailable = !!settings.directProvider && !!(settings.providerKeys?.[settings.directProvider] || "").trim();
    if (!workersAvailable) {
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"Parallel workers need a direct model provider, which isn't configured here. Do these sub-tasks yourself, one at a time, on the main tab."}`;
    }
    if (subtasks.length > MAX_SUBTASKS) {
      this.ui.systemNote(`⚠️ ${subtasks.length} subtasks requested — running the first ${MAX_SUBTASKS}. Re-run for the rest.`);
      subtasks.length = MAX_SUBTASKS;
    }

    const total = subtasks.length;
    const reqConc = Number(action.concurrency || action.parallel || action.lanes || 0) || DEFAULT_WORKER_CONCURRENCY;
    const lanes = Math.max(1, Math.min(reqConc, MAX_WORKER_CONCURRENCY, total));

    this.ui.setProgressLabel?.(`fan-out: ${total} tasks · ${lanes} at a time`);
    this.ui.systemNote(`🧵 Spawning ${total} parallel worker${total === 1 ? "" : "s"} (${lanes} tab${lanes === 1 ? "" : "s"} at a time). Workers browse read-only; sensitive actions stay with me.`);

    // One chip per subtask for live per-task visibility.
    const chips = subtasks.map((s, i) => this.ui.addChip(`🧵 [${i + 1}/${total}] ${String(s.goal).slice(0, 46)}`, s.url || ""));
    const results = new Array(total);

    // Parallel workers can't safely share the single approval-dialog slot, and the
    // user opted into an autonomous fan-out — so auto-run non-sensitive browsing
    // and deny anything sensitive. BrowserWorker passes its lane's latest
    // snapshot as the 2nd arg — sensitive-CLICK detection needs the element's
    // snapshot line (with "" it would never fire).
    const workerGate = (wAction, wSnapshot) => Promise.resolve(isSensitiveAction(wAction, wSnapshot || "") ? "deny" : "run");

    // Open the lane tabs.
    const laneTabs = [];
    try {
      for (let i = 0; i < lanes; i++) laneTabs.push(await this.tools.spawnWorkerTab());
    } catch (e) {
      for (const t of laneTabs) await this.tools.closeWorkerTab(t).catch(() => {});
      return `[BROWSER_RESULT] {"tool":"${action.tool}","ok":false,"error":"Couldn't open worker tabs: ${escapeForJson(e.message)}"}`;
    }

    let cursor = 0, completed = 0;
    const runLane = async (laneTabId) => {
      let used = false;
      const scoped = this.tools.scopedTo(laneTabId);
      while (true) {
        if (this.stopped) return;
        const idx = cursor++;
        if (idx >= total) return;
        const sub = subtasks[idx];

        // Position the lane tab: go to the subtask's start URL, or reset to blank on reuse.
        try {
          if (sub.url) await scoped.navigate({ url: sub.url });
          else if (used) await scoped.navigate({ url: "about:blank" });
        } catch { /* worker will navigate itself */ }
        used = true;

        const worker = new BrowserWorker({
          tools: scoped,
          getSettings: this.getSettings,
          workerModel: settings.workerModel || null,
          onStep: (step) => this.ui.setWorking(true, `worker ${idx + 1}/${total} — step ${step + 1} (${completed}/${total} done)`),
        });
        this._activeWorkers.add(worker);
        let report;
        try {
          report = await worker.execute(sub.goal, { approvalGate: workerGate, resultSchema: sub.schema });
        } catch (e) {
          report = { success: false, summary: `Worker error: ${e.message}`, observations: null, data: null };
        } finally {
          this._activeWorkers.delete(worker);
          worker.close?.();
        }

        results[idx] = { goal: sub.goal, ...report };
        completed++;
        const note = report.success ? String(report.summary || "ok").slice(0, 60) : "failed";
        chips[idx].setResult(!!report.success, note, report.success ? null : `Task: ${sub.goal}\n\n${report.summary || "failed"}`);
        this.ui.setProgressLabel?.(`fan-out: ${completed}/${total} done`);
      }
    };

    try {
      await Promise.all(laneTabs.map(t => runLane(t)));
    } finally {
      for (const t of laneTabs) await this.tools.closeWorkerTab(t).catch(() => {});
    }

    // Any slot left unrun (user stopped mid-batch) → mark it so aggregation is complete.
    for (let i = 0; i < total; i++) {
      if (!results[i]) {
        results[i] = { goal: subtasks[i].goal, success: false, summary: "not run (stopped)", data: null };
        chips[i].setResult(false, "skipped");
      }
    }

    const okCount = results.filter(r => r && r.success).length;
    this._ledger.push(`fan-out ${total} sub-tasks → ${okCount} ok, ${total - okCount} failed`);
    return this.buildFanOutReport(action.tool, results);
  }

  /** Aggregate parallel-worker results into one compact [BROWSER_RESULT] for the planner. */
  buildFanOutReport(tool, results) {
    const succeeded = results.filter(r => r.success).length;
    const compact = results.map(r => {
      const o = { goal: String(r.goal || "").slice(0, 140), success: !!r.success, summary: String(r.summary || "").slice(0, 300) };
      if (r.data && typeof r.data === "object") o.data = r.data;
      if (Array.isArray(r.observations) && r.observations.length) o.observations = r.observations.slice(0, 5);
      return o;
    });
    const payload = { tool, ok: true, total: results.length, succeeded, failed: results.length - succeeded, results: compact };
    const str = safeJsonStringify(payload, 2000, 40000); // truncates fields first — always valid JSON
    return `[BROWSER_RESULT] ${str}\n[SYSTEM] All ${results.length} parallel workers finished (${succeeded} succeeded, ${results.length - succeeded} failed). The worker tabs are closed and you are back on the main tab. Aggregate/compare these results and continue the task — or, if everything is done, run your final verification and emit {"tool":"done","verified":true}.`;
  }

  // ------------------------------------------------------- context economy

  /**
   * Render a fresh snapshot for the LLM: a compact DIFF when possible, the
   * full tree otherwise. Diffs are CUMULATIVE against the last FULL snapshot
   * that was sent (_prevSnap) — not against the previous diff — so any single
   * diff + that full snapshot is self-contained, and older diffs can be
   * pruned from the conversation. When the page changed a lot (or navigated),
   * a fresh full tree is sent and becomes the new base.
   */
  renderSnapshot(snapText, { full = false, cap = 12000 } = {}) {
    let sent = String(snapText || "");
    if (sent.length > cap) {
      // Cut at a line boundary — a mid-line cut would make later diffs see a
      // phantom half-element.
      const nl = sent.lastIndexOf("\n", cap);
      sent = sent.slice(0, nl > 0 ? nl : cap) + "\n…(truncated — tree exceeds " + cap + " chars; use get_text/find for more)";
    }
    if (!full && this._prevSnap) {
      const d = diffSnapshots(this._prevSnap, sent);
      // Diff only pays off when the page changed little; on big changes send full.
      if (d && d.ratio <= 0.5) return markSection("PAGE ELEMENTS DIFF", d.diff);
    }
    this._prevSnap = sent; // new base — subsequent diffs are relative to this full tree
    return markSection("PAGE ELEMENTS", sent);
  }

  /** The model's usable context window (tokens) for compaction decisions. */
  contextLimit(settings) {
    return Number(settings.contextTokenLimit)
      || getPreset(settings.directProvider)?.contextWindow
      || 100000;
  }

  /**
   * CONTEXT OVERFLOW MECHANISM. When the next request would approach the
   * model's context window (or the provider already rejected it — force=true),
   * drop the turn's tool context and replace it with a deterministic recap:
   * original task + action ledger + last progress + fresh snapshot. Built
   * locally (no LLM call — an over-limit context couldn't be summarized by the
   * model anyway), so it also works at the moment of hard overflow.
   * Returns the (possibly replaced) body to send.
   */
  async maybeCompactContext(body, settings, { force = false } = {}) {
    if (!this.chat.canCompact?.()) return body; // gateway mode — server owns history
    if (!force) {
      const limit = this.contextLimit(settings);
      const used = (this.chat.contextTokens?.() || 0) + estimateTokens(body);
      if (used < limit * 0.8) return body;
      this.ui.systemNote(`🧹 Context is filling up (~${Math.round(used / 1000)}k of ${Math.round(limit / 1000)}k tokens) — compacting: dropping old tool results, keeping a task recap + fresh snapshot.`);
    } else {
      this.ui.systemNote(`🧹 The model rejected the request as too long — compacting the context and retrying.`);
    }
    const recap = await this.buildCompactionRecap(body);
    this.chat.compactTurn?.();
    // NOTE: buildCompactionRecap reset the diff base and re-seeded it with the
    // recap's own full snapshot — later snapshots diff against that.
    return recap;
  }

  /** Deterministic recap of the turn so far (task, ledger, page state). */
  async buildCompactionRecap(pendingBody) {
    // The message holding the current diff base is about to be dropped with the
    // rest of the tool context — invalidate the base FIRST, unconditionally, so
    // a failed recap snapshot can't leave diffs pointing at vanished content.
    this._prevSnap = null;
    const parts = [
      `[CONTEXT COMPACTED] Older tool results of this turn were dropped to fit the model's context window. This recap replaces them — trust it, do NOT redo completed steps.`,
      `[ORIGINAL TASK]\n${this._turnUserText || "(see conversation)"}`,
    ];
    if (this._lastProgressLabel) parts.push(`[LAST PROGRESS] ${this._lastProgressLabel}`);
    if (this._ledger.length) {
      const shown = this._ledger.slice(-80);
      const start = this._ledger.length - shown.length;
      parts.push(`[ACTIONS SO FAR — ${this._ledger.length} total${start ? `, last ${shown.length} shown` : ""}]\n` +
        shown.map((l, i) => `${start + i + 1}. ${l}`).join("\n"));
    }
    if (pendingBody) {
      parts.push(`[LATEST RESULT]\n${stripBulkySections(pendingBody).slice(0, 2000)}`);
    }
    try {
      const info = await this.tools.tabInfo();
      if (info.ok) parts.push(`[BROWSER_CONTEXT] Active tab: ${info.url} — "${info.title}"`);
      const snap = await this.tools.run({ tool: "snapshot" });
      if (snap.ok && snap.snapshot) {
        this.lastSnapshot = snap.snapshot;
        parts.push(this.renderSnapshot(snap.snapshot, { full: true })); // re-seeds the diff base
      }
    } catch { /* restricted page etc. — model can snapshot itself */ }
    parts.push(`[SYSTEM] Re-read the original task and the action log, update your checklist, then continue with the next browser action (or run final verification and emit a verified done).`);
    return parts.join("\n\n");
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
      if (result.ok && typeof result.snapshot === "string" && result.snapshot) this.lastSnapshot = result.snapshot;
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
    // Record a compact one-liner for the compaction recap (context overflow).
    this._ledger.push(ledgerLine(action, result));
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
    } else if (result.ok && typeof result.snapshot === "string" && result.snapshot) {
      // Snapshot-shaped result (covers every alias — tools.run normalizes the
      // name internally). Bulky content lives OUTSIDE the JSON, in a marked
      // section: it stays prunable later and the JSON payload always stays valid.
      body = `[BROWSER_RESULT] {"tool":"snapshot","ok":true}\n`
        + this.renderSnapshot(result.snapshot, { full: action.full === true });
    } else if (result.ok && typeof result.text === "string" && result.text.length > 300 && result.url !== undefined) {
      // get_text-shaped result (any alias)
      const capped = result.text.length > 20000 ? result.text.slice(0, 20000) + `\n…(truncated, ${result.text.length - 20000} more chars)` : result.text;
      const meta = safeJsonStringify({ tool: "get_text", ok: true, url: result.url, title: result.title, truncated: !!result.truncated || result.text.length > 20000 }, 500, 2000);
      body = `[BROWSER_RESULT] ${meta}\n` + markSection("PAGE TEXT", capped);
    } else {
      const compact = { tool: action.tool, ...result };
      // Remove internal fields not meant for LLM
      delete compact._autoRetrySnapshot;
      delete compact.snapshot; // failed-snapshot edge: never inline bulk into JSON
      // Truncates long string FIELDS first — output is always valid JSON.
      body = `[BROWSER_RESULT] ${safeJsonStringify(compact, 4000, 24000)}`;
      // If auto-retry snapshot was taken, append fresh refs for LLM
      if (result._autoRetrySnapshot) {
        body += `\n` + this.renderSnapshot(result._autoRetrySnapshot, {});
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

    // Auto-snapshot after navigation so the agent immediately sees the new page.
    // Sent as a DIFF against the previous snapshot when the page is the same —
    // on a typical SPA click that's a few lines instead of the whole tree.
    if (!["fill", "press"].includes(action.tool)) {
      try {
        const snap = await this.tools.run({ tool: "snapshot" });
        if (snap.ok && snap.snapshot) {
          this.lastSnapshot = snap.snapshot;
          append += `\n` + this.renderSnapshot(snap.snapshot, {});
        }
      } catch (e) {
        append += `\n[NOTE] Auto-snapshot failed: ${e.message}. You may need to wait and snapshot manually.`;
      }
    }
    this.setGlow(true);
    return append;
  }

  /** Returns "run" | "deny". Asks the user if needed.
   *  `snapshotOverride` — the delegating worker's own latest snapshot, when the
   *  action comes from a sub-agent whose page state the planner hasn't seen. */
  async approvalGate(action, settings, snapshotOverride = null) {
    if (READ_ONLY_TOOLS.has(action.tool)) return "run";

    const info = await this.tools.tabInfo();
    let origin = "";
    try { origin = new URL(info.url || "").origin; } catch { /* none */ }

    const fresh = this.getSettings();
    const sensitive = isSensitiveAction(action, snapshotOverride ?? this.lastSnapshot);

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

/**
 * One compact line per executed action — the raw material for the
 * context-compaction recap. Keep it short: 200 steps must stay ~3k tokens.
 */
function ledgerLine(action, result) {
  const bits = [action.tool];
  for (const k of ["ref", "url", "key", "label", "to", "query"]) {
    if (action[k] !== undefined && action[k] !== null && action[k] !== "") {
      bits.push(`${k}=${String(action[k]).slice(0, 80)}`);
      break;
    }
  }
  if (action.value !== undefined) bits.push(`value="${String(action.value).slice(0, 40)}"`);
  const ok = result?.ok !== false;
  let line = `${bits.join(" ")} → ${ok ? "ok" : "FAIL: " + String(result?.error || "").split("\n")[0].slice(0, 80)}`;
  if (ok && result?.clicked) line += ` (${String(result.clicked).slice(0, 50)})`;
  if (ok && result?.url && action.tool !== "navigate") line += ` (now: ${String(result.url).slice(0, 60)})`;
  return line;
}

/**
 * Normalize the many shapes an LLM may use for a fan-out into a clean
 * [{ goal, url|null, schema|null }] list. Accepts subtasks/tasks/workers/items,
 * each a bare string or an object with goal/task/intent/text/query (+ optional
 * url/startUrl and schema/result_schema). A top-level result_schema/schema
 * applies to every subtask that doesn't specify its own.
 */
function normalizeSubtasks(action) {
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
