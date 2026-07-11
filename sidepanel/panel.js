// Side panel — THIN VIEW. All logic (WS to OpenClaw, agent loop,
// transcripts) lives in the service worker; the panel only renders and sends
// commands via Port. The panel is tied to a tab group (?group=<id>) — it exists
// only on tabs in that group, and the agent keeps working when the panel disappears.

import { renderMarkdown } from "./md.js";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");

let groupId = Number(new URLSearchParams(location.search).get("group"));
let port = null;
let assistantName = "Andrzej";
let pendingBubble = null;          // streaming response bubble
const chips = new Map();           // id -> chip handle (browser actions)
const srvChips = new Map();        // itemId -> chip handle (server tools)
const approvalCards = new Map();   // id -> approval card

// ---------------------------------------------------------------- rendering

function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

function addMsg(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  if (role !== "system") {
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "You" : assistantName;
    wrap.appendChild(who);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollDown();
  return bubble;
}

function addChipEl(label, why, status = "…") {
  const chip = document.createElement("div");
  chip.className = "action-chip";
  const lab = document.createElement("span");
  lab.textContent = label;
  chip.appendChild(lab);
  if (why) {
    const w = document.createElement("span");
    w.className = "why";
    w.textContent = "— " + why;
    chip.appendChild(w);
  }
  const st = document.createElement("span");
  st.className = "status";
  st.textContent = status;
  chip.appendChild(st);
  chatEl.appendChild(chip);
  scrollDown();
  return {
    el: chip,
    setResult(ok, note) {
      chip.classList.add(ok ? "ok" : "fail");
      st.textContent = note || (ok ? "ok" : "error");
      scrollDown();
    },
  };
}

function systemNote(text) { addMsg("system", text); }

function addShot(dataUrl) {
  const bubble = addMsg("system", "");
  bubble.textContent = "";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.className = "shot-thumb";
  img.style.margin = "0 auto";
  bubble.appendChild(img);
  scrollDown();
}

function setWorking(on, label) {
  $("working").classList.toggle("hidden", !on);
  if (label) $("working-label").textContent = label;
  $("btn-send").disabled = !!on;
}

function onPartial(fullText) {
  const cut = fullText.split(/```(?:browser|json)/)[0];
  if (!pendingBubble) pendingBubble = addMsg("assistant", "");
  pendingBubble.innerHTML = renderMarkdown(cut);
  scrollDown();
}

function onAssistantFinal(text) {
  if (pendingBubble) {
    pendingBubble.innerHTML = renderMarkdown(text);
    pendingBubble = null;
  } else {
    addMsg("assistant", text);
  }
}

function addApprovalCard({ id, description, why, origin, sensitive }) {
  const card = document.createElement("div");
  card.className = "approval";
  const q = document.createElement("div");
  q.className = "q";
  q.innerHTML = `${sensitive ? "⚠️ <b>Sensitive action.</b> " : ""}${assistantName} wants to: <b></b>${why ? `<div class="muted"></div>` : ""}`;
  q.querySelector("b").textContent = description;
  if (why) q.querySelector(".muted").textContent = "Reason: " + why;
  card.appendChild(q);

  const btns = document.createElement("div");
  btns.className = "buttons";
  const mk = (cls, label, val) => {
    const b = document.createElement("button");
    b.className = cls; b.textContent = label;
    b.addEventListener("click", () => send({ t: "approval", id, answer: val }));
    btns.appendChild(b);
  };
  mk("yes", "Execute", "yes");
  mk("", "Reject", "no");
  if (origin && !sensitive) mk("always", "Always on this site", "always");
  card.appendChild(btns);

  const verdict = document.createElement("div");
  verdict.className = "verdict";
  card.appendChild(verdict);

  chatEl.appendChild(card);
  scrollDown();
  approvalCards.set(id, { card, verdict });
}

function finishApprovalCard(id, verdictText) {
  const a = approvalCards.get(id);
  if (!a) return;
  a.card.classList.add("done");
  a.verdict.textContent = verdictText;
  approvalCards.delete(id);
}

function renderTranscript(messages) {
  chatEl.innerHTML = "";
  chips.clear(); srvChips.clear(); approvalCards.clear();
  pendingBubble = null;
  if (!messages?.length) {
    systemNote(`Hi! I'm ${assistantName} 🦞 This conversation is pinned to this tab group — drag more tabs into the group to expand my scope. I can read pages and take actions: click, fill, navigate.`);
    return;
  }
  for (const m of messages) {
    if (m.role === "chip") addChipEl(m.text, null, m.note || (m.ok ? "ok" : "error")).el.classList.add(m.ok ? "ok" : "fail");
    else addMsg(m.role, m.text);
  }
}

// ---------------------------------------------------------------- status / site bar

function setConnState(state, detail = "") {
  const dot = $("conn-dot");
  const dotClass = state === "online" ? "online" : state === "offline" ? "offline" : "connecting";
  dot.className = "dot " + dotClass;
  dot.title = state === "online" ? `Connected to OpenClaw${detail ? " — " + detail : ""}`
    : state === "pairing" ? "Waiting for device approval"
    : state === "connecting" ? "Connecting…"
    : `Disconnected${detail ? ": " + detail : ""}`;
  const showHint = state === "offline" || state === "pairing";
  $("offline-hint").classList.toggle("hidden", !showHint);
  if (showHint) {
    $("offline-hint").querySelector("b").textContent =
      state === "pairing" ? "Pair this device with OpenClaw." : "No connection to OpenClaw.";
    $("offline-reason").textContent = detail || "";
  }
}

function setSite({ label, allowed, origin, tabCount }) {
  $("site-label").textContent = (tabCount > 1 ? `[${tabCount} tabs] ` : "") + (label || "—");
  $("site-allow").checked = !!allowed;
  $("site-allow").disabled = !origin;
}

// Model catalog grouped by backend: OpenClaw + each provider with a key.
// Option value: "<group>::<modelId>", where group is "openclaw" or "direct:<id>".
function setCatalog({ groups, active }) {
  const sel = $("model-select");
  sel.innerHTML = "";
  if (!groups?.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "⚙︎ configure in settings"; o.disabled = true;
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const activeVal = active ? `${active.group}::${active.model || ""}` : "";
  let matched = false;
  for (const g of groups) {
    const og = document.createElement("optgroup");
    og.label = g.label;
    if (!g.models.length) {
      const o = document.createElement("option");
      o.value = `${g.key}::`; o.textContent = "(default / connect to load list)";
      og.appendChild(o);
      if (o.value === activeVal) { o.selected = true; matched = true; }
    }
    for (const m of g.models) {
      const o = document.createElement("option");
      o.value = `${g.key}::${m.id}`;
      o.textContent = (m.label || m.id).replace(/^.*\//, "");
      if (o.value === activeVal) { o.selected = true; matched = true; }
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  // if the saved selection is in a group without a model list — select its default entry
  if (!matched && active) {
    const fallback = [...sel.options].find((o) => o.value.startsWith(active.group + "::"));
    if (fallback) fallback.selected = true;
  }
}

function renderHistory(items) {
  const list = $("history-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<p class="muted" style="padding:10px">No saved conversations.</p>`; return; }
  for (const it of items) {
    const item = document.createElement("div");
    item.className = "hist-item";
    if (it.current) item.style.borderColor = "var(--accent)";
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "🗑";
    del.addEventListener("click", (e) => { e.stopPropagation(); send({ t: "history-del", key: it.key }); });
    const title = document.createElement("div");
    title.textContent = (it.current ? "● " : "") + it.title;
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = new Date(it.updatedAt).toLocaleString("en-US");
    item.append(del, title, when);
    item.addEventListener("click", () => {
      send({ t: "history-pick", key: it.key });
      $("history-pane").classList.add("hidden");
    });
    list.appendChild(item);
  }
}

function debugLine(line) {
  const pane = $("debug-pane");
  pane.classList.remove("hidden");
  const log = $("debug-log");
  log.textContent += line + "\n";
  if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-40000);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- port to SW

function send(msg) {
  try { port?.postMessage(msg); } catch { /* disconnected — reconnect in progress */ }
}

function onMessage(msg) {
  switch (msg.t) {
    case "state": {
      assistantName = msg.assistantName || "Andrzej";
      $("assistant-name").textContent = assistantName;
      $("debug-pane").classList.toggle("hidden", !msg.debug);
      renderTranscript(msg.transcript);
      setConnState(msg.conn?.state || "offline", msg.conn?.reason || "");
      setWorking(msg.working, `${assistantName} is working…`);
      if (msg.approval) addApprovalCard(msg.approval);
      if (msg.prefill) { $("input").value = msg.prefill; autoGrow(); $("input").focus(); }
      break;
    }
    case "user": addMsg("user", msg.text); break;
    case "assistant": onAssistantFinal(msg.text); break;
    case "partial": onPartial(msg.text); break;
    case "note": systemNote(msg.text); pendingBubble = null; break;
    case "chip-add": chips.set(msg.id, addChipEl(msg.label, msg.why)); break;
    case "chip-res": chips.get(msg.id)?.setResult(msg.ok, msg.note); chips.delete(msg.id); break;
    case "srv-act": {
      const icon = msg.kind === "command" ? "🖥️" : msg.kind === "patch" ? "📝" : msg.kind === "search" ? "🔍" : "🔧";
      if ((msg.phase === "start" || !srvChips.has(msg.itemId)) && msg.phase !== "end") {
        if (!srvChips.has(msg.itemId)) srvChips.set(msg.itemId, addChipEl(`${icon} ${msg.title}`, null));
      }
      if (msg.phase === "end") {
        srvChips.get(msg.itemId)?.setResult(msg.status === "completed", msg.status === "completed" ? "ok" : msg.status);
        srvChips.delete(msg.itemId);
      }
      break;
    }
    case "approval-req": addApprovalCard(msg); break;
    case "approval-done": finishApprovalCard(msg.id, msg.verdict); break;
    case "working": setWorking(msg.on, msg.label); if (!msg.on) pendingBubble = null; break;
    case "conn": setConnState(msg.state, msg.reason); break;
    case "site": setSite(msg); break;
    case "catalog": setCatalog(msg); break;
    case "shot": addShot(msg.dataUrl); break;
    case "history": renderHistory(msg.items); break;
    case "reset": renderTranscript(msg.transcript || []); break;
    case "prefill": $("input").value = msg.text; autoGrow(); $("input").focus(); break;
    case "debug": debugLine(msg.line); break;
  }
}

function connectPort() {
  if (!Number.isFinite(groupId)) {
    systemNote("This panel is not pinned to a tab group. Click the extension icon 🦞 on a tab to start.");
    return;
  }
  port = chrome.runtime.connect({ name: `panel-${groupId}` });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 500); // wakes the service worker and restores state
  });
  // Auto-focus input when panel connects
  setTimeout(() => $("input").focus(), 100);
}

// ---------------------------------------------------------------- interactions

function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

function sendMessage() {
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  send({ t: "send", text, includePage: $("ctx-page").checked, includeShot: $("ctx-shot").checked });
}

$("btn-send").addEventListener("click", sendMessage);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("input").addEventListener("input", autoGrow);
// Escape clears the input when it has text, or blurs it when empty
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("history-pane").classList.contains("hidden")) {
      $("history-pane").classList.add("hidden");
      return;
    }
    const input = $("input");
    if (input.value) { input.value = ""; autoGrow(); input.focus(); }
    else input.blur();
  }
});
$("btn-stop").addEventListener("click", () => send({ t: "stop" }));
$("btn-new").addEventListener("click", () => send({ t: "new-chat" }));
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-reconnect").addEventListener("click", () => send({ t: "reconnect" }));
$("model-select").addEventListener("change", (e) => {
  const v = e.target.value || "";
  const i = v.indexOf("::");
  if (i < 0) return;
  send({ t: "select-backend", group: v.slice(0, i), model: v.slice(i + 2) });
});
$("site-allow").addEventListener("change", (e) => send({ t: "site-toggle", allowed: e.target.checked }));
$("btn-history").addEventListener("click", () => {
  const pane = $("history-pane");
  pane.classList.toggle("hidden");
  if (!pane.classList.contains("hidden")) send({ t: "history-list" });
});
$("btn-history-close").addEventListener("click", () => $("history-pane").classList.add("hidden"));

// ---------------------------------------------------------------- composer resize

// Drag handle to resize the composer area (adjusts #composer height)
(() => {
  const handle = $("resize-handle");
  const composer = $("composer");
  const chat = $("chat");
  let dragging = false;
  let startY = 0;
  let startComposerHeight = 0;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startComposerHeight = composer.getBoundingClientRect().height;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // up = positive = bigger
    const newHeight = Math.max(80, Math.min(startComposerHeight + dy, window.innerHeight - 100));
    composer.style.flex = `0 0 ${newHeight}px`;
    chat.scrollTop = chat.scrollHeight;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
})();

// Group is taken from ?group= (subsequent tab activations). On a fresh open
// via click, the panel gets ?tab=<id> instead of a group (group doesn't exist yet) —
// we then ask the service worker, which creates/finds the group for this tab.
async function resolveGroupAndConnect() {
  if (!Number.isFinite(groupId)) {
    const params = new URLSearchParams(location.search);
    const tabId = Number(params.get("tab"));
    if (Number.isFinite(tabId)) {
      // Opened with explicit ?tab=<id>
      await tryBindTab(tabId);
    } else {
      // No URL params — opened via icon click with openPanelOnActionClick.
      // Query the active tab in this window.
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active) await tryBindTab(active.id);
      } catch { /* query failed */ }
    }
  }
  connectPort();
}

async function tryBindTab(tabId) {
  for (let attempt = 0; attempt < 3 && !Number.isFinite(groupId); attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ t: "bind-tab", tabId });
      if (res && Number.isFinite(res.groupId)) { groupId = res.groupId; break; }
    } catch { /* SW might still be waking up — retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}
resolveGroupAndConnect();
