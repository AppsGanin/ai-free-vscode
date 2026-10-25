# 🚀 AI Free VSCode

[![GitHub stars](https://img.shields.io/github/stars/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/network)
[![GitHub watchers](https://img.shields.io/github/watchers/AppsGanin/ai-free-vscode.svg?style=social)](https://github.com/AppsGanin/ai-free-vscode/watchers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS_Code-%5E1.105.0-success.svg)](https://code.visualstudio.com)
[![VS Marketplace Version](https://vsmarketplacebadges.dev/version-short/AppsGanin.free-ai-vscode.png)](https://marketplace.visualstudio.com/items?itemName=AppsGanin.free-ai-vscode)
[![VS Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/AppsGanin.free-ai-vscode.png)](https://marketplace.visualstudio.com/items?itemName=AppsGanin.free-ai-vscode)
[![VS Marketplace Rating](https://vsmarketplacebadges.dev/rating-short/AppsGanin.free-ai-vscode.png)](https://marketplace.visualstudio.com/items?itemName=AppsGanin.free-ai-vscode)

> Use free AI models directly in Copilot Chat without API keys, billing, or token counting.

> ⚠️ **Read before use.** This is not an official API: the extension drives the providers' regular web chats. Your account **can be banned or rate-limited — temporarily or permanently** — and any provider may work unstably or stop working at any time. See [Important notice](#important-notice).

**AI Free VSCode** connects free web-based models through a Playwright browser session and registers them as a Copilot Chat provider.

## What it does

- ✅ Integrates free web-based AI models into Copilot Chat
- ✅ Requires no API keys and does not use paid OpenAI endpoints
- ✅ Authenticates via a real browser session
- ✅ Supports streaming, automatic thinking mode, and tool calling
- ✅ Exposes models through a unified provider for VS Code
- ✅ Generates commit messages from your staged diff
- ✅ Inline code suggestions (ghost text) on demand
- ✅ "Fix with AI" Quick Fix on errors/warnings, with a diff preview
- ✅ Add your own OpenAI-compatible endpoints (Ollama, LM Studio, any gateway)
- ✅ One settings page for everything: `AI Free VSCode — Open Settings`
- ✅ The same providers in [DeepSeek Harness](#deepseek-harness-plugin) too, as the `dsh-plugin-free-ai` plugin

Only models from providers you are signed into appear in the picker — no
dead entries that fail on use.

## Demo

### Chat

![Chat demo](media/chat.gif)

### Generate commit messages

![Commit message generation demo](media/generate-commits.gif)

### Fix with AI

![Fix with AI demo](media/fix.gif)

## Supported models

### Qwen

| Model        | ID             | Context |
| ------------ | -------------- | ------- |
| Qwen3.8 Max  | `qwen3.8-max`  | 1M      |
| Qwen3.7 Plus | `qwen3.7-plus` | 1M      |
| Qwen3.7 Max  | `qwen3.7-max`  | 1M      |
| Qwen3.6 Plus | `qwen3.6-plus` | 1M      |
| Qwen3.5 Plus | `qwen3.5-plus` | 1M      |

### DeepSeek

| Model           | ID                 | Context |
| --------------- | ------------------ | ------- |
| DeepSeek        | `deepseek-default` | 128K    |
| DeepSeek Expert | `deepseek-expert`  | 128K    |

### Kimi

| Model        | ID             | Context |
| ------------ | -------------- | ------- |
| Kimi Instant | `kimi-instant` | 128K    |

Kimi Instant is whatever plain chat model the Kimi web app offers at the
moment (K2.6 Instant on kimi.ai); the extension reads it from Kimi's own model
list. The agent models (K3, K2.8) run inside Kimi's server-side sandbox and are
not offered.

> **How Kimi is kept on your tools.** Kimi has its own server-side tools
> (`ipython`, `shell`) that no request option turns off, and on long sessions
> it reaches for them — the work would then happen in Kimi's sandbox, with none
> of your files. The extension stops such a call before Kimi runs it: a command
> or Python run goes to your terminal tool instead (with the usual
> confirmation), anything else is asked again with a reminder.


### Z.ai

| Model         | ID              | Context |
| ------------- | --------------- | ------- |
| GLM-5.3       | `glm-5.3`       | 128K    |
| GLM-5.2       | `glm-5.2`       | 128K    |
| GLM-5.3 Flash | `glm-5.3-flash` | 128K    |
| GLM-4.7       | `glm-4.7`       | 128K    |

### Your own OpenAI-compatible endpoints

Anything that serves `POST {baseUrl}/chat/completions` can be added as a
provider: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, a corporate gateway.
Its models show up in the same picker, next to the free web ones.

Run **`AI Free VSCode — Open Settings`**, then _+ Add endpoint_:

| Field    | Example                    | Notes                                             |
| -------- | -------------------------- | ------------------------------------------------- |
| Name     | `LM Studio`                | Shown in the model picker                         |
| Base URL | `http://localhost:1234/v1` | A bare origin gets `/v1` appended automatically   |
| API key  | `sk-...`                   | Stored in SecretStorage, never in `settings.json` |
| Models   | _(empty)_                  | Empty = fetched from `GET {baseUrl}/models`       |

_Test & load models_ checks the connection and fills the list; leave the list
empty to keep it in sync with the endpoint, or pin an exact set by hand (useful
on OpenRouter, where the catalogue is hundreds of models long).

Unlike the web backends, these speak the OpenAI tools API, so tool calls and
tool results travel structurally — agent mode works as it does with a paid
provider, as far as the model behind the endpoint supports it.

Everything except the key is kept in `freeAI.custom.providers`, so it syncs with
your settings and can be edited as JSON if you prefer:

```jsonc
"freeAI.custom.providers": [
  {
    "name": "Ollama",
    "baseUrl": "http://localhost:11434/v1",
    "noApiKey": true          // local server, no credentials
  },
  {
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "models": ["qwen/qwen3-coder:free", "deepseek/deepseek-r1:free"],
    "thinking": true          // streams reasoning_content
  }
]
```

## How it works

1. The extension registers a single Copilot Chat provider: `free-ai-vscode`.
2. Signing in launches Playwright and stores the authenticated session in `SecretStorage`.
3. Requests are routed through the providers' private API streams (see [Supported models](#supported-models)).
4. Responses are delivered to VS Code as streamed chunks.
5. The extension handles tool calling and thinking-mode when available.

### Qwen and the Aliyun WAF

`chat.qwen.ai` sits behind the Aliyun WAF and Alibaba's anti-bot layer, which
reject plain server-side requests. Qwen keeps working through a two-tier flow:

**1. Direct request (fast path).** The Qwen client calls the API directly from
Node while mirroring the request headers the web app sends (`source`, `version`,
`x-request-id`, `timezone`, `bx-v`). That is enough to pass the WAF for most
endpoints (e.g. creating a chat), and responses stream natively.

**2. Browser bridge (fallback).** When a response is a challenge instead of the
expected stream — an HTML challenge page, or an `x5sec` / `RGV587`
(`FAIL_SYS_USER_VALIDATE`) JSON body — the request is transparently replayed
inside the real browser session, which carries the genuine cookies and browser
network fingerprint the WAF trusts. The SSE response is still streamed back to
VS Code chunk by chunk.

The bridge reuses the persistent profile created at sign-in
(`~/.ai-free-vscode/browser-profile`), so no extra login is needed, and it
degrades gracefully:

1. **Headless + stealth** first — no visible window (fingerprint is masked so the
   anti-bot treats the session as a normal browser).
2. If the anti-bot detects it, the bridge **escalates to a real (headed) Chrome**
   automatically, with its window minimized so it stays out of your way.
3. If a one-time **captcha** is required, that window is brought to the front and
   a notification appears — solve it once, then resend your request. The
   verification cookie is stored in the profile, so you are not asked again for a
   while.

You normally don't need to touch this, but you can pin the browser mode in
**Settings → AI Free VSCode → `freeAI.qwen.browserMode`** (`auto` / `headed` /
`headless`; changing it needs a window reload).

> This is a best-effort resilience layer. Provider-side anti-bot rules change
> frequently, so a blocked Qwen request may still occasionally surface — retrying
> usually clears it.

### Z.ai and the browser bridge

`chat.z.ai` signs each completion request inside its own web app and runs an
invisible captcha before it. So Z.ai has no direct client at all: every message
is typed into the real chat page, in a Chrome window kept minimized off-screen,
and the page sends it itself. The answer is copied from the page's own stream
back to VS Code as it arrives; the model and thinking mode are set on the
outgoing request.

- The window uses the profile created at sign-in
  (`~/.ai-free-vscode/zai-browser-profile`), so no extra login is needed.
- Each request is a throwaway chat, deleted afterwards — your chat.z.ai
  history stays clean.
- If the captcha ever turns interactive, the window is brought to the front
  with a notification. Complete it there — the request continues by itself.
- Requests are sent one at a time, and each opens a fresh chat page, so a
  reply starts a couple of seconds later than with the other providers.

## Installation

### From the VS Code Marketplace (recommended)

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version/AppsGanin.free-ai-vscode.png)](https://marketplace.visualstudio.com/items?itemName=AppsGanin.free-ai-vscode)

- In VS Code, open the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`), search for **AI Free VSCode**, and click **Install**.
- Or from the command line:
  ```bash
  code --install-extension AppsGanin.free-ai-vscode
  ```
- Or open it directly on the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=AppsGanin.free-ai-vscode).

### From a VSIX (manual)

1. Download the latest `free-ai-vscode-*.vsix` from the [Releases](https://github.com/AppsGanin/ai-free-vscode/releases) page.
2. In VS Code, open Extensions → `···` → **Install from VSIX...**.
3. Reload VS Code.

## Quick start

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
2. Run the sign-in command:
   - `AI Free VSCode — Sign In`
3. Choose a provider from the list (see [Supported models](#supported-models)).
4. Sign in with your browser and wait for success.
5. Open Copilot Chat and select a model.

Prefer a UI? Run `AI Free VSCode — Open Settings` instead: it has sign-in for
every provider, your own OpenAI-compatible endpoints, and all settings on one
page.

To sign out:

- `AI Free VSCode — Sign Out`

To check auth status:

- `AI Free VSCode — Status`

## DeepSeek Harness plugin

The same providers also work in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), DeepSeek's open-source agent harness, through the [`dsh-plugin-free-ai`](https://www.npmjs.com/package/dsh-plugin-free-ai) plugin. It lives in [`dsh-plugin/`](dsh-plugin) and shares this extension's provider code.

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-free-ai
npx @deepseek-ai/dsh web
```

- Model routes: `qwen-web`, `deepseek-web`, `kimi-web`, `zai-web`; pick one in the model selector or set it as `agent-default-model`.
- The first request to a provider opens its sign-in window; `/free-ai status`, `/free-ai login <provider>` and `/free-ai logout <provider>` in an open session manage the sign-ins.
- The plugin keeps its own sign-ins and browser profiles under `~/.ai-free-vscode/dsh`, so it runs alongside VS Code.

Requirements, configuration and the model list: [dsh-plugin/README.md](dsh-plugin/README.md). The same [Important notice](#important-notice) applies.

## Editor features

Besides Copilot Chat, the extension adds a few editor integrations powered by the
same free models. All of them respect your sign-in state and use thinking off for
speed.

### Commit message generation

A ✨ button in the **Source Control** view title bar generates a commit message
from your staged diff (falls back to the working-tree diff). The message streams
straight into the commit input box.

- Model: `freeAI.commit.model` (`auto` = first available)
- Prompt: `freeAI.commit.prompt` (Conventional Commits, English by default)
- Pick a model quickly: command `AI Free VSCode — Change Commit Model`

Every model declares which features it is fit for — `chat`, `commit`,
`suggestions`, `fix` — and each picker lists only the fit ones. The flags are
independent: commit, suggestions and Quick Fix talk to the providers directly,
so a model hidden from chat still works for them.

Only models of providers you are signed into are ever picked. If the chosen one
fails before it has produced any text, the request is retried against your other
signed-in providers, one model each — so a provider that is rate-limited or has
lost its session does not break the feature while another is available.

### Inline suggestions (ghost text)

On-demand code completion at the cursor. It is **manual only** — it never fires
while typing.

- Trigger: `Ctrl+Alt+\` (Mac `Cmd+Alt+\`), or command
  `AI Free VSCode — Suggest Code at Cursor`, or the built-in _Trigger Inline Suggestion_
- Accept with `Tab`, dismiss with `Esc`
- Enable first: set `freeAI.suggestions.enabled` to `true` (the hotkey will offer
  to enable it)
- Model: `freeAI.suggestions.model` (`auto` = first available)
- Pick a model quickly: command `AI Free VSCode — Change Completions Model`

While a suggestion is being generated the status bar shows
`AI Free: suggesting…`; if nothing usable comes back it briefly says so instead
of failing silently. Generation stops on its own after 30 seconds, 12 lines or
600 characters — whichever comes first — and whatever arrived by then is offered
as the suggestion.

> These backends run through a web session (DeepSeek also solves a PoW challenge),
> so expect noticeably higher latency than native Copilot. If Copilot itself is
> active, its suggestion usually wins the race and you see that one instead.

### Fix with AI (Quick Fix)

When there is a red error or yellow warning, open the lightbulb (`Cmd+.` /
`Ctrl+.`) and choose **✨ Fix with AI Free**. The model rewrites the affected
lines (indentation is preserved) and shows a **diff preview** with Apply / Cancel
before changing the file.

- Toggle the action: `freeAI.fix.enabled`
- Model: `freeAI.fix.model` (`auto` = first available)
- Pick a model quickly: command `AI Free VSCode — Change Fix Model`

## Configuration

Everything below is also editable on one page: **`AI Free VSCode — Open Settings`**
(sign-in status, your own endpoints, and every setting).

| Setting                             | Default  | Description                                                       |
| ----------------------------------- | -------- | ----------------------------------------------------------------- |
| `freeAI.custom.providers`           | `[]`     | Your own OpenAI-compatible endpoints (keys live in SecretStorage) |
| `freeAI.playwright.timeout`         | `120000` | Browser sign-in timeout in milliseconds                           |
| `freeAI.qwen.browserMode`           | `auto`   | Qwen anti-bot fallback browser: `auto` / `headed` / `headless`    |
| `freeAI.zai.browserMode`            | `auto`   | Z.ai bridge browser: `auto` / `headed` / `headless`               |
| `freeAI.proxy`                      | —        | Proxy for the extension's browser windows (see below)             |
| `freeAI.debug`                      | `false`  | Verbose DEBUG logs in the output channel (see below)              |
| `freeAI.commit.enabled`             | `true`   | Show the ✨ commit message generation button in Source Control    |
| `freeAI.commit.model`               | `auto`   | Model for commit messages (`auto` = first available)              |
| `freeAI.commit.prompt`              | —        | Instruction prepended to the diff for commit generation           |
| `freeAI.suggestions.enabled`        | `false`  | Enable manual inline ghost-text suggestions                       |
| `freeAI.suggestions.model`          | `auto`   | Model for inline suggestions                                      |
| `freeAI.suggestions.maxPrefixChars` | `2000`   | Chars of code before the cursor sent to the model                 |
| `freeAI.suggestions.maxSuffixChars` | `800`    | Chars of code after the cursor sent to the model                  |
| `freeAI.fix.enabled`                | `true`   | Show the "Fix with AI Free" Quick Fix on diagnostics              |
| `freeAI.fix.model`                  | `auto`   | Model for fixing problems                                         |

Thinking (reasoning) is automatic: enabled in plain chat, disabled when tools are
active (reasoning is unreliable with tool calling on these backends).

### Proxy

Requests the extension makes itself already follow VS Code's `http.proxy` (and
`http.noProxy`). The browser windows — sign-in and the Qwen / Z.ai bridges —
run as a separate Chrome process and take the same proxy too, so setting
`http.proxy` alone covers everything. `freeAI.proxy` overrides it for the
browsers only, e.g. for a SOCKS proxy: `http://host:port`,
`http://user:pass@host:port` or `socks5://host:port`. A change applies to
newly opened browser windows; reload VS Code to apply it to a running bridge.

### Reporting a problem

1. Turn on `freeAI.debug` (**Verbose debug logs** on the settings page).
2. Reproduce the problem.
3. Run **`AI Free VSCode — Copy Debug Report`** (or the button next to the
   checkbox) and paste the result into a
   [GitHub issue](https://github.com/AppsGanin/ai-free-vscode/issues/new),
   together with what you did and what you expected.

The report holds your VS Code / OS / extension versions, the relevant settings,
which providers are signed in, and the recent log: every chat request with its
own `[#id]`, timings, HTTP statuses, the browser that was launched, errors with
their stack, and an excerpt of the model's raw output. Tokens, cookies, keys,
proxy passwords and e-mail addresses are masked automatically, but the log can
contain fragments of your prompts and the model's answers — skim it before
posting.

## Development

```bash
git clone https://github.com/AppsGanin/ai-free-vscode
cd ai-free-vscode
npm install
# If you need local Chromium for development:
npx playwright install chromium
```

Run the extension in VS Code with `F5`.

### Tests

```bash
npm test            # offline: parsers, adapter, every provider client (~1 s)
npm run test:live   # real requests to Qwen, DeepSeek, Kimi and Z.ai
```

**Offline tests** (`test/`) need no network or accounts. Each provider client
is fed canned upstream streams through a stubbed `fetch` (Z.ai through a fake
browser bridge), split into small pieces the way real streams arrive. They
cover the tool-call dialects, text/reasoning separation, error mapping, the
order of parts the chat UI receives, and argument re-typing against tool
schemas.

**Live tests** (`test/live/`) send real requests through the same path a chat
takes (adapter → provider → upstream) and catch what canned data cannot: a
changed stream format, a new anti-bot step, a model that stopped following the
tool protocol. They read each provider's session from its browser profile in
`~/.ai-free-vscode/`, so:

- a provider that is not signed in opens a browser window on its sign-in
  page and the run waits for you (5 min; `LIVE_LOGIN_TIMEOUT=600` for longer,
  never on CI) — or sign in through the extension beforehand;
- close the VS Code dev host — Chrome lets one process hold a profile, and a
  locked profile is skipped with the reason.

`test/live/agent.test.ts` runs a **full agent session** per model: a small
project with planted bugs and a six-part task (run tests, fix the code, add a
function and its test, update the README), worked through with Copilot's own
tools for dozens of steps. It passes only if the project really ends up
correct — tests green, the new function right, the original tests untouched —
and every tool call along the way matched its schema. A step-by-step
transcript of each run lands in `test/live/.reports/`.

```bash
npm run test:live -- test/live/agent.test.ts          # every provider (~10–30 min)
npm run test:live -- test/live/agent.test.ts -t qwen  # one provider
```

A provider that is overloaded on its side ("at capacity", rate limits) marks
the affected test skipped with that reason rather than failed, so a red live
run always points at something in this repository. The Z.ai bridge tests run
in a throwaway guest profile and answer the completion endpoint themselves, so
they need no account and cost no model calls.

### Enabling/disabling providers at build time

Each provider can be excluded from a build via a `PROVIDER_<NAME>=false`
environment variable (accepted falsy values: `false`, `0`, `off`, `no`).
By default all providers are included. The build prints the active set, e.g.
`[build] enabled providers: deepseek, kimi`.

```bash
# Build without Qwen
PROVIDER_QWEN=false npm run bundle

# Build with only DeepSeek (drop Qwen and Kimi)
PROVIDER_QWEN=false PROVIDER_KIMI=false npm run bundle

# Package a VSIX without Qwen
PROVIDER_QWEN=false npm run bundle && npm run package
```

Provider keys: `qwen`, `deepseek`, `kimi`, `zai`. Adding a new provider means
registering its key in [`src/providers/providerConfig.ts`](src/providers/providerConfig.ts),
[`esbuild.js`](esbuild.js), and the factory map in [`src/extension.ts`](src/extension.ts).

## Requirements

- VS Code `^1.105.0`
- System Chrome or network access for Playwright to download Chromium

## Important notice

This is an unofficial extension. Authentication is handled through a browser session, and none of the providers offers this as an API — the extension automates their regular web chats.

- **Account bans.** Providers can detect automated use and restrict your account or IP: a temporary block (a captcha, a pause of several minutes or hours, "too many requests") or a **permanent ban**. Use an account you can afford to lose, and avoid bursts of requests.
- **Instability.** Because this is not a real API, every provider may work unstably: slow or empty answers, captchas, expired sessions, or sudden breakage when a site changes its web app, anti-bot rules or terms. A fix may take a while, and some models may disappear.
- **No guarantees.** Availability, speed and quality are decided by the providers, not by this extension.

> Use at your own risk. Web session automation may violate provider policies.

## 💝 Support the project

AI Free VSCode is built in spare time and distributed for free. If the extension has been useful, you can support its development.

The easiest way is via **[DonationAlerts](https://www.donationalerts.com/r/dmitryapp)** or **[Boosty](https://boosty.to/githubapps)** (one-time or recurring). You can also donate in USDT — pick a
network and **carefully** copy the address (the sender's and recipient's networks must match):

| Network          | Token | Address                                            |
| ---------------- | ----- | -------------------------------------------------- |
| TRC20 (Tron)     | USDT  | `TJwyrPVEZVZ1YrcmDiZTyFjLo3Q2DmEGzs`               |
| ERC20 (Ethereum) | USDT  | `0xf9d663146ce902da91911b214c71cc73a5269d1d`       |
| Solana           | USDT  | `2qAZRTbaUMTfYuZbD1dCYHjkYgxkw4dUYE9XY3JhC2Cs`     |
| TON              | USDT  | `UQDoat731MLYuIw8ayL3Vhhw7zTBbLvRaQFmDvab--CNNI7e` |

If you also use Bybit, the simplest option is a transfer by **UID** (instant and fee-free):

| Exchange | UID         |
| -------- | ----------- |
| Bybit    | `136462734` |

> The cheapest fees are on the **TRON (TRC20)** and **TON** networks. Send only
> **USDT** and only on the specified network — a transfer on the wrong network is unrecoverable.

Thanks for your support! 🙏
