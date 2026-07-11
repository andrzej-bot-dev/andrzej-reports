import { loadSettings, saveSettings } from "../lib/settings.js";
import { OpenClawGateway } from "../lib/gateway.js";
import { DirectBackend } from "../lib/direct.js";
import { PROVIDER_PRESETS } from "../lib/providers.js";
import { brandSvg } from "../lib/brandicons.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- tabs

function wireTabs() {
  const btns = [...document.querySelectorAll(".tabs button")];
  btns.forEach((btn) => btn.addEventListener("click", () => {
    btns.forEach((b) => b.classList.toggle("active", b === btn));
    const id = btn.dataset.tab;
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `tab-${id}`));
  }));
}

// ---------------------------------------------------------------- LLM providers

// Fills a provider's model dropdown. `models` is a list (strings or {id});
// `selected` is the model to select (preserved even if outside the list).
function fillModelSelect(pid, models, selected) {
  const sel = $(`pmodel-${pid}`);
  const cur = selected != null ? selected : sel.value;
  sel.innerHTML = "";
  const ids = [...new Set(models.map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean))];
  if (cur && !ids.includes(cur)) ids.unshift(cur);
  if (!ids.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "enter API key to load models"; o.disabled = true;
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  for (const id of ids) {
    const o = document.createElement("option");
    o.value = id; o.textContent = id;
    if (id === cur) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = false;
}

function buildProviderRows(keys, models, urls) {
  const wrap = $("providers");
  const urlWrap = $("provider-urls");
  wrap.innerHTML = "";
  urlWrap.innerHTML = "";
  for (const p of PROVIDER_PRESETS) {
    const row = document.createElement("div");
    row.className = "prov-row";
    row.innerHTML = `
      <div class="prov-head">
        ${brandSvg(p.id, 24)}
        <span class="pname">${p.label}</span>
        <span class="pfmt">${p.format === "anthropic" ? "Anthropic-compatible" : "OpenAI-compatible"}</span>
      </div>
      <div class="prov-line">
        <input type="password" id="key-${p.id}" placeholder="API key (${p.keyHint})" autocomplete="off">
        <a href="${p.keysUrl}" target="_blank" rel="noopener" class="prov-key">get a key ↗</a>
      </div>
      <div class="prov-model">
        <div class="prov-line">
          <select id="pmodel-${p.id}" title="Model for this provider" disabled></select>
          <button type="button" class="ghost prov-test" data-id="${p.id}">Refresh models</button>
        </div>
        <div class="prov-result" id="pres-${p.id}"></div>
      </div>`;
    wrap.appendChild(row);
    $(`key-${p.id}`).value = keys[p.id] || "";
    fillModelSelect(p.id, [], models[p.id] || "");

    // Auto-fetch models when API key is entered (on blur, with debounce)
    const keyInput = $(`key-${p.id}`);
    keyInput.addEventListener("blur", () => {
      const val = keyInput.value.trim();
      if (val && val.length > 5) {
        fetchModels(p.id);
      }
    });
    // Also auto-fetch on paste (common flow: paste key from clipboard)
    keyInput.addEventListener("paste", () => {
      setTimeout(() => {
        const val = keyInput.value.trim();
        if (val && val.length > 5) {
          fetchModels(p.id);
        }
      }, 100);
    });

    const urlRow = document.createElement("div");
    urlRow.innerHTML = `<label>${p.label}</label><input type="text" id="url-${p.id}" placeholder="${p.baseUrl}">`;
    urlWrap.appendChild(urlRow);
    $(`url-${p.id}`).value = urls[p.id] || "";
  }
}

// Fetches the current model list from a provider (live /models) and fills the dropdown.
async function fetchModels(pid) {
  const out = $(`pres-${pid}`);
  out.className = "prov-result";
  out.textContent = "fetching…";
  const key = $(`key-${pid}`).value.trim();
  const urlOverride = $(`url-${pid}`)?.value.trim();
  if (!key) { out.className = "prov-result err"; out.textContent = "enter an API key first"; return; }
  const be = new DirectBackend({
    getSettings: () => ({
      providerKeys: { [pid]: key },
      providerBaseUrls: urlOverride ? { [pid]: urlOverride } : {},
      directMaxTokens: 1024,
    }),
  });
  be.setSelection(pid, "");
  try {
    const models = await be.listModels();
    fillModelSelect(pid, models, $(`pmodel-${pid}`).value);
    out.className = "prov-result ok";
    out.textContent = `OK ✓ ${models.length} models — select from the list above`;
  } catch (e) {
    out.className = "prov-result err";
    out.textContent = "error: " + e.message;
  }
}

// ---------------------------------------------------------------- init / save

async function init() {
  wireTabs();

  const origin = `chrome-extension://${chrome.runtime.id}`;
  $("ext-origin").value = origin;
  $("ext-config").value = JSON.stringify({
    gateway: {
      bind: "lan",
      auth: { mode: "token", token: "YOUR_LONG_RANDOM_TOKEN" },
      controlUi: { allowedOrigins: [origin] },
    },
  }, null, 2);

  const s = await loadSettings();
  $("gw-url").value = s.gatewayUrl;
  $("gw-url-remote").value = s.gatewayUrlRemote;
  $("gw-token").value = s.gatewayToken;
  $("a-name").value = s.assistantName;
  $("a-mode").value = s.actionMode;
  $("a-maxsteps").value = s.maxSteps;
  $("a-maxtok").value = s.directMaxTokens;
  $("a-screenshots").checked = s.allowScreenshots;
  $("a-debug").checked = s.debug;

  buildProviderRows(s.providerKeys || {}, s.providerModels || {}, s.providerBaseUrls || {});
  // Auto-fetch models on init for providers that have a key
  for (const p of PROVIDER_PRESETS) {
    if (s.providerKeys?.[p.id]) {
      fetchModels(p.id);
    }
  }

  document.querySelectorAll(".prov-test").forEach((b) =>
    b.addEventListener("click", () => fetchModels(b.dataset.id)));
}

$("btn-save").addEventListener("click", async () => {
  const providerKeys = {};
  const providerModels = {};
  const providerBaseUrls = {};
  for (const p of PROVIDER_PRESETS) {
    const k = $(`key-${p.id}`).value.trim();
    if (k) providerKeys[p.id] = k;
    const m = $(`pmodel-${p.id}`).value.trim();
    if (m) providerModels[p.id] = m;
    const u = $(`url-${p.id}`).value.trim().replace(/\/+$/, "");
    if (u) providerBaseUrls[p.id] = u;
  }
  await saveSettings({
    gatewayUrl: $("gw-url").value.trim().replace(/\/+$/, ""),
    gatewayUrlRemote: $("gw-url-remote").value.trim().replace(/\/+$/, ""),
    gatewayToken: $("gw-token").value.trim(),
    assistantName: $("a-name").value.trim() || "Andrzej",
    actionMode: $("a-mode").value,
    maxSteps: Math.max(1, Math.min(50, Number($("a-maxsteps").value) || 15)),
    directMaxTokens: Math.max(256, Math.min(128000, Number($("a-maxtok").value) || 8192)),
    allowScreenshots: $("a-screenshots").checked,
    debug: $("a-debug").checked,
    providerKeys,
    providerModels,
    providerBaseUrls,
  });
  const st = $("status");
  st.textContent = "Saved ✓";
  st.className = "ok";
  setTimeout(() => (st.textContent = ""), 2500);
});

$("btn-test").addEventListener("click", async () => {
  const out = $("test-result");
  out.className = "";
  out.textContent = "Connecting…";
  const gw = new OpenClawGateway({
    urls: [$("gw-url").value.trim(), $("gw-url-remote").value.trim()].filter(Boolean),
    token: $("gw-token").value.trim(),
  });
  try {
    const hello = await gw.connect({ timeoutMs: 8000 });
    let modelsInfo = "";
    try {
      const models = await gw.listModels();
      modelsInfo = models?.length
        ? `\nModels (${models.length}): ${models.slice(0, 8).map(m => m.id || m).join(", ")}${models.length > 8 ? "…" : ""}`
        : "\n(model list unavailable)";
    } catch (e) {
      modelsInfo = `\n(couldn't fetch models: ${e.message})`;
    }
    out.className = "ok";
    out.textContent = `Connected ✓  ${hello?.serverInfo || ""}\nAddress: ${hello?.url || ""}${modelsInfo}`;
  } catch (e) {
    out.className = "err";
    out.textContent = `Connection error: ${e.message}\n\nCheck:\n• gateway is listening on LAN (not just loopback)\n• address/port and token\n• README → "Raspberry Pi configuration" section`;
  } finally {
    gw.close();
  }
});

init();
