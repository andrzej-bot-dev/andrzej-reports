# 🦞 Andrzej — OpenClaw for Chrome

A Chrome extension that works like **Claude in Chrome**, but instead of Claude it
talks to **your own OpenClaw** (e.g. on a Raspberry Pi in your local network).

- 🗂️ **session = tab group, like in Claude in Chrome**: clicking the icon on a tab creates
  an orange 🦞 group with a separate conversation; drag tabs into the group to
  expand the agent's scope; outside group tabs the panel doesn't show at all
- 💬 conversation in a side panel, streaming responses, chat history
- 🖱️ browser actions: clicking, typing text, forms, scrolling,
  navigation, opening tabs, reading pages, screenshots
- 🧠 model selection from your gateway's model list (`/model` per session)
- 🛡️ permission model like in Claude in Chrome: asks before each action by default,
  per-site autopilot can be enabled ("Always on this site"); sensitive actions
  (payments, passwords, sending, deleting) always require confirmation
- 🔧 server action preview: when OpenClaw uses its own tools (bash, etc.),
  chips with their status appear in the transcript
- 🌟 page edge glow when the agent is working + highlight on clicked elements
- 🧩 zero dependencies and builds — pure JS, load the directory via "Load unpacked"

Your OpenClaw keeps its personality, memory and tools — the extension
talks to it via Gateway (WebSocket, protocol v4), and adds browser
actions as an extra "hand" in your Chrome.

Tested against OpenClaw `2026.6.11` (protocol v4).

### 🔀 Two modes (switchable in the panel) — like the Jan app

The extension also works **without OpenClaw** — directly with any LLM via API:

- **OpenClaw mode** — gateway on Raspberry Pi (Andrzej persona, memory, tools).
- **Direct mode** — sends directly to a provider's API in **OpenAI-compatible**
  or **Anthropic-compatible** format. Ready presets (you only enter an API key, no
  addresses needed): **Claude (Anthropic)**, **ChatGPT (OpenAI)**, **Gemini (Google)**,
  **DeepSeek**, **Z.ai (GLM)**, **Qwen (Alibaba)**, **Kimi (Moonshot)**.

You select mode and model from **one dropdown** in the panel — grouped by
source (an "OpenClaw 🦞" group + a separate group for each provider you've added
a key for). Selecting an item from a group switches mode and model at once. Browser
actions (click/type/navigate) work the same in both modes.

---

## 1. Installing the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right corner)
3. Click **Load unpacked** and select this directory
4. Note the **Extension ID** visible on the card (or open ⚙︎ Extension Settings —
   the ID and a ready config snippet are displayed there)
5. Configure the gateway on your Raspberry Pi (section 2), then in ⚙︎ Settings enter
   the address and token, click **Test connection**

Panel keyboard shortcut: `Cmd+Shift+O` / `Ctrl+Shift+O`. Context menu
(right-click): "Ask Andrzej about selection", "Translate selection",
"Summarize this page".

If you want to use OpenClaw — section 2. If direct mode is enough
(any LLM via API key) — section 1b and you can skip the Pi configuration.

## 1b. Direct mode — add an API key (optional)

In ⚙︎ Settings open the **"🔑 Models & keys"** tab:

1. For your chosen provider (Claude, ChatGPT, Gemini, DeepSeek, Z.ai, Qwen, Kimi —
   each has its own logo) click **"where to get a key ↗"**, generate an API key
   and paste it into the field.
2. Click **"Fetch models"** — the extension will pull the current model list
   using your key and populate the dropdown (no need to type names).
3. Select a model from the list and **Save**. The same model will be suggested in the panel.
4. In the panel, in the model dropdown, switch to that provider's group.

API addresses and format (OpenAI-/Anthropic-compatible) are in the presets — you don't need
to enter them. If a provider changes their endpoint, the address can be overridden in "Advanced".
Keys are stored locally (`chrome.storage.local`) in this browser; requests go directly
to the provider's API from the extension's service worker (no intermediary).

Default model identifiers are best current guesses — the extension fetches the live list
from the provider's `/models` endpoint anyway, so the dropdown will show what you actually
have access to under your key.

## 2. Configuring OpenClaw on Raspberry Pi (one-time)

The gateway by default listens only on `127.0.0.1` and rejects unknown browser origins.
Three steps:

**a) LAN listening + token + extension origin** — in `~/.openclaw/openclaw.json`
add/fill in (a copyable snippet is also shown in extension settings):

```json5
{
  gateway: {
    bind: "lan",                       // default is "loopback" — without this you can't connect from a laptop
    auth: { mode: "token", token: "YOUR_LONG_RANDOM_TOKEN" },
    controlUi: {
      allowedOrigins: ["chrome-extension://<EXTENSION_ID>"]
    }
  }
}
```

You can check/set the token via CLI: `openclaw config get gateway.auth.token`.
After changes, restart the gateway (e.g. `openclaw gateway restart` or restart the service).

> Safer alternative to `bind: "lan"`: Tailscale and `bind: "tailnet"`.

**b) First connection attempt = device pairing.** The extension has a persistent
Ed25519 identity; on first LAN connection the gateway will create a pending
pairing and refuse (`PAIRING_REQUIRED`) — the panel will show what to do. On the Raspberry Pi:

```bash
openclaw devices list
openclaw devices approve --latest
```

The extension will reconnect automatically after approval (retries every few seconds).
You do pairing **once** — the gateway remembers the device afterwards.

**c) In extension settings** enter `ws://<pi-address>:18789`
(e.g. `ws://raspberrypi.local:18789` or `ws://192.168.1.50:18789`) and the token.

## 2b. Remote access (outside home)

The extension supports **two addresses**: local and remote. At home it connects over
LAN; when the local address doesn't respond (different Wi-Fi, traveling), it automatically
tries the remote one. Enter the remote address in settings in the "Remote address" field, e.g.
`wss://openclaw.codingwithdawid.com`.

Device pairing is **independent of the route** — the extension's Ed25519 identity
is the same over LAN and over the internet, so if you've already approved the device,
it works through the tunnel without extra steps. Token and `allowedOrigins` also stay the same.

### Recommended: Cloudflare Tunnel (you have a domain — perfect fit)

Zero open ports on the router, free TLS, hidden home IP, doesn't mind dynamic IP.
Requires the domain DNS `codingwithdawid.com` to be on Cloudflare (free plan).

On the Raspberry Pi:

```bash
# install cloudflared (Raspberry Pi OS 64-bit)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel login                 # will open browser authorization
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw openclaw.codingwithdawid.com
```

Config `~/.cloudflared/config.yml`:

```yaml
tunnel: openclaw
credentials-file: /home/pi/.cloudflared/<TUNNEL_ID>.json   # path was printed by `tunnel create`
ingress:
  - hostname: openclaw.codingwithdawid.com
    service: http://localhost:18789
  - service: http_status:404
```

Run as a service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

In the extension: remote address `wss://openclaw.codingwithdawid.com`. WebSockets
pass through Cloudflare without extra configuration, and the gateway ticks every 30s,
so the connection isn't killed as idle. You can keep `gateway.bind: "lan"` (the tunnel
enters via localhost anyway, and LAN is useful at home).

### Option 2: Tailscale (simplest safely, no domain)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
openclaw config set gateway.bind tailnet   # or keep "lan" if you want both
```

Install the Tailscale app on your laptop and use
`ws://<pi-name-in-tailnet>:18789` as the remote address. Downside: every computer
you use must have the Tailscale client.

### Option 3: port forwarding + reverse proxy (classic)

Requires a public IP (or DDNS) and opening port 443 on the router → Pi.

```bash
sudo apt install caddy
# /etc/caddy/Caddyfile:
#   openclaw.codingwithdawid.com {
#       reverse_proxy localhost:18789
#   }
sudo systemctl reload caddy
```

Caddy will automatically get a Let's Encrypt certificate and proxy WebSocket. Remote
address: `wss://openclaw.codingwithdawid.com`.

### Security notes for public exposure

- Publicly **only `wss://`** (tunnel/proxy provides TLS) — never bare `ws://`.
- Two OpenClaw layers protect access: **token** (keep it long and random) and
  **Ed25519 device pairing** — an unknown device still waits for your
  `openclaw devices approve`. The gateway also has a built-in auth attempt rate limiter.
- Through a tunnel/proxy connections have forwarded headers, so OpenClaw treats them
  as remote — loopback auto-pairing doesn't work (and that's good); you approve
  manually once per device.
- The subdomain doesn't need to be "hidden" — but don't link it publicly anywhere,
  fewer bots will come knocking.

## 3. Tab groups = sessions (like in Claude)

- **Click 🦞 on any tab** → the tab joins a new orange tab group, and the group
  gets its own conversation with Andrzej. The side panel works **only on tabs in
  this group** — switch to a tab outside the group and the panel disappears;
  come back and it's there again, with the same conversation.
- **Drag a tab into the group** to add it to the session scope (the panel will
  enable on it automatically). Drag a tab out — the panel turns off on it.
- **Multiple groups at once = multiple independent conversations** (each with its
  own OpenClaw session, they can work in parallel).
- The agent operates on the active tab of the group; new tabs it opens go **into
  the same group**. When you browse something outside the group, **it keeps working
  in the background** on the group's last active tab (the connection and agent loop
  live in the service worker, not in the panel). When it's waiting for your approval,
  a "!" badge appears on the 🦞 icon.
- Closing the last tab of a group ends the session in Chrome; the conversation stays
  in history (🕘) and can be attached to a new group. After a Chrome restart groups
  get new identifiers — you restore a conversation from history with one click.
- Clicking the icon on a tab that's already in **your own group** doesn't create a
  new one — it adopts the existing group (without changing its color/name).

## 4. How it works

```
┌────────────── Chrome ──────────────┐          ┌───── Raspberry Pi ─────┐
│  side panel (chat, model select)    │ WS (v4)  │   OpenClaw Gateway     │
│  action loop (lib/agent.js)         │ ───────► │   agent + models       │
│  content script (click/type/read)   │ ◄─────── │   memory, tools        │
└────────────────────────────────────┘          └────────────────────────┘
```

1. The panel sends your message via `chat.send` to a dedicated session
   (`chrome-ext:<id>`, on the server `agent:main:chrome-ext:<id>`) along
   with the active tab context (URL, title; optionally page content 📄
   and screenshot 📸 as an image attachment).
2. On the first message in a session, the extension appends a **preamble** teaching
   the agent the action protocol: the agent can end its reply with one block
   ```` ```browser {"tool":"click","ref":"e12","why":"..."} ```` 
3. The extension executes the action on the page (content script highlights the element),
   shows it as a chip and sends back the result (`[BROWSER_RESULT]`).
4. The loop continues until the agent replies without an action block or the step limit is hit.
   Responses stream live (events `chat` delta/final, correlated by
   `runId`); the ■ stop button sends `chat.abort`.

Messages starting with `/` go to OpenClaw without processing — so
`/status`, `/model`, `/new`, `/think`, `/compact` etc. work. Selecting a model in the panel
header is simply `/model <id>` for the current session.

### Tools available to the agent

`snapshot` (page element map with refs e1, e2…), `get_text`,
`screenshot`, `click`, `fill`, `press`, `select_option`, `scroll`, `find`,
`navigate`, `back`, `new_tab`, `wait_for`, `wait`, `tab_info`,
`fan_out` (parallel sub-workers — see below).

### Parallel fan-out (orchestration of multiple LLM sessions)

The agent can delegate independent tasks to **parallel sub-workers**, each in its
own tab with its own LLM session. This turns sequential O(N) work into parallel O(1):

```
User: "for every product in my cart, find a cheaper alternative"

Planner (main session, strong model):
  1. snapshot cart → extract N products
  2. {"tool":"fan_out","tasks":[
       {"goal":"find cheaper alternative for: Red Shirt M (249kr)","url":"…"},
       {"goal":"find cheaper alternative for: Blue Jeans L (499kr)","url":"…"},
       …
     ]}
  3. each task → new tab + BrowserWorker (cheaper model, stateless)
  4. workers run in parallel (concurrency-capped, default 4)
  5. planner receives compressed reports {success, summary, observations}
  6. synthesizes: "Here are alternatives for 3 of your 5 items…"
```

- **Thinking vs navigation split**: the planner (strong model) holds the high-level
  plan and synthesizes results; workers (cheaper model) handle DOM navigation and
  return compressed reports — the planner's context stays clean (no DOM noise).
- **Tab = progress view**: each worker gets its own tab in the group. Click into
  tab 3 to watch worker 3 navigate. The tab-group title shows aggregate progress.
- **Sub → sub-sub**: workers can themselves emit `fan_out` to delegate further
  (recursion depth capped, default 2 levels).
- **Batch approval**: one approval for the whole fan-out plan; workers inherit
  autopilot for non-sensitive actions; sensitive actions still gate individually.
- **Worker tabs are closed** after completion — the compressed report is returned
  to the planner, so tabs don't clutter the browser.
- Requires a **direct provider API key** for workers (they use DirectBackend, not
  the OpenClaw gateway). Configure in ⚙ Settings → Models & keys.
- Settings: max parallel workers, max tasks, worker timeout, max depth — all in
  ⚙ Settings → Assistant & actions → Parallel fan-out.

## 5. Security

- **Default mode: ask for everything** — every state-changing action
  (click, typing, navigation) requires clicking "Execute". Read-only actions (snapshot,
  text, screenshot) and scroll execute without asking.
- **Per-site autopilot** — "Always on this site" when approving, or
  the "auto-actions" toggle above the chat.
- **Sensitive actions always require confirmation** — heuristics detect password fields /
  payment card fields and buttons like "buy / pay / send / delete / transfer".
- **Passwords** — the agent is forbidden from typing them; it will ask you to type them yourself.
- **Prompt injection** — page content is marked as untrusted data, but
  this is only mitigation: don't enable autopilot on sites you don't trust.
  Remember also that "reading the page" = sending its content to your OpenClaw
  server (and further to the model provider you use).
- The gateway token is stored in `chrome.storage.local` on this computer.

## 6. Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| "Connection lost (1006)…" | Gateway not listening on LAN (`gateway.bind: "lan"`), wrong address/port, firewall |
| "No address responds…" | Check local and remote address; outside home a tunnel/proxy must work (section 2b) |
| "Gateway rejected Origin…" | Add `chrome-extension://<ID>` to `gateway.controlUi.allowedOrigins`, restart gateway |
| "Device waiting for approval…" | `openclaw devices approve --latest` on the Raspberry Pi |
| "Wrong gateway token" | `openclaw config get gateway.auth.token` and paste into settings |
| "Protocol version mismatch" | Update OpenClaw (`openclaw update`) — the extension speaks protocol v4 |
| No model list (OpenClaw) | The extension then shows "(default)"; you can also set the model with `/model <id>` in chat |
| Click doesn't work on some page | Events are synthetic; some sites require trusted events — tell the agent to try differently (e.g. navigation) |
| Panel doesn't work on `chrome://…` | Chrome limitation — actions only on regular web pages |
| "No API key for…" | Direct mode without a key — add a provider key in ⚙︎ Settings (section 1b) |
| "Bad API key for…" (401) | Key invalid/expired — generate a new one from the provider and paste again |
| Provider model not in list | Click "Fetch models" in the "Models & keys" tab; if still missing — check address in "Advanced" |

For diagnostics, enable "debug panel" in options — it shows raw WS frames
(with token and signature masked).

## 7. Limitations

- Actions work in the active tab of regular web pages (not `chrome://`, Web Store).
- Cross-origin frames (iframes) are not supported in v1.
- A screenshot is sent to the agent only if the model in OpenClaw accepts images
  (otherwise the extension falls back to a text snapshot).
- One action per agent step (intentionally — like in Claude in Chrome, you see
  each step and can abort). Fan-out is the exception: it spawns parallel workers
  that each act autonomously in their own tabs.
- Fan-out workers use a direct provider API key (not the OpenClaw gateway).
  If you're in OpenClaw mode, add at least one provider key in ⚙ Settings
  for fan-out to work.

## 8. Code structure

```
manifest.json          — MV3, side panel per tab, permissions (tabGroups…)
background.js          — service worker (module): brain — connections, sessions, groups
lib/groups.js          — tab groups ↔ sessions; panel enabled per group tab
lib/controller.js      — conversation controller (per group): transcript, panel ports
lib/gateway.js         — OpenClaw backend: WS client (protocol v4, multi-session)
lib/direct.js          — direct backend: LLM via API (OpenAI/Anthropic-compatible)
lib/providers.js       — provider presets (addresses, format, models, key link)
lib/brandicons.js      — provider logos as inline SVG (options page)
lib/device.js          — Ed25519 device identity (OpenClaw pairing)
lib/agent.js           — agent loop + ```browser block protocol
lib/worker.js          — stateless sub-agent (browser DOM heavy lifting, fan_out support)
lib/fanout.js          — parallel fan-out executor (tab creation, worker spawning, report collection)
lib/semaphore.js       — concurrency limiter for parallel workers
lib/tools.js           — tool executor within a tab group
lib/settings.js        — settings (chrome.storage)
sidepanel/panel.*      — thin chat view (Port to service worker)
sidepanel/md.js        — Markdown renderer
content/content.js     — DOM actions: snapshot, click, typing, scroll…
options/options.*      — settings page (tabs: models/keys, OpenClaw, assistant)
```

Architecture: the panel is just a view — the WebSocket to OpenClaw and agent loops
run in the service worker (kept alive by WS traffic + alarms), so the agent
continues working when the panel is hidden or closed.

Implemented based on the OpenClaw protocol documentation
(`docs.openclaw.ai/gateway/protocol`) and `openclaw` package sources;
handshake, pairing and chat tested against a real gateway.
