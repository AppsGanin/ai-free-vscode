# dsh-plugin-free-ai

Qwen, DeepSeek, Kimi and Z.ai web chats as model providers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), signed in with your own browser account. The same provider core as the [AI Free VSCode](https://github.com/AppsGanin/ai-free-vscode) extension.

> Unofficial. It drives the providers' web chats the way their own web apps do; their terms of service apply, and a change on their side can break it until the plugin is updated.

## Requirements

- DeepSeek Harness 0.2.x (`npm i -g @deepseek-ai/dsh`), Node.js 20 or newer.
- Google Chrome. The sign-in windows and the Qwen and Z.ai browser bridges run in your installed Chrome: the providers' anti-bot checks let it through, unlike an automated browser. Without Chrome the plugin falls back to Playwright's Chromium, which you then install with `npx playwright install chromium`.
- An account on each provider you use (free).

## Install

DSH keeps each way of running it in its own profile, and a plugin is installed per profile. Install it into the ones you use:

| How you run DSH | Install |
| --- | --- |
| Web UI (`dsh web`) | `dsh plugin --profile web add dsh-plugin-free-ai` |
| Terminal UI (`dsh tui`) | `dsh plugin --profile tui add dsh-plugin-free-ai` |
| Desktop app | **Plugins** in the sidebar → **Add plugin** → `dsh-plugin-free-ai` |
| One task and exit (`dsh headless "…"`) | `dsh plugin --profile headless add dsh-plugin-free-ai` |

Without a global install, prefix the commands with `npx @deepseek-ai/`, e.g. `npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-free-ai`. In the Web UI the same **Plugins → Add plugin** page works as in Desktop. Restart DSH after installing.

The sign-ins are shared: every profile reads them from `~/.ai-free-vscode/dsh`, so signing in once covers all of them.

## Use

Model routes: `qwen-web`, `deepseek-web`, `kimi-web`, `zai-web`. In the Web UI, Desktop and TUI pick a model in the model selector. To make one the default (and for headless runs), set it in the profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: agent-default-model
  config:
    provider: qwen-web
    model: qwen3.8-max

- id: agent-loop
  config:
    agents:
      - id: main
        provider: qwen-web
        model: qwen3.8-max
        cwd: !!js process.cwd()
```

`agent-default-model` matters as well: other parts of the harness (session titles, subagents) use it, and its shipped default is the paid `deepseek-official` route, which fails without an API key.

Qwen and Z.ai may ask for a captcha in a browser window now and then, more often for a new profile; solve it there and the request continues.

Models: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus` (Qwen); `deepseek-default`, `deepseek-expert` (DeepSeek); `kimi-instant` (Kimi); `glm-5.3`, `glm-5.2`, `glm-5.3-flash`, `glm-4.7` (Z.ai). The harness model picker lists them per route.

## Signing in and out

The first request to a route without a session opens that provider's sign-in window by itself. To manage sessions ahead of time, use the `/free-ai` command in the chat input of an open session (Web, Desktop and TUI; headless runs have no commands, so sign in from one of those first, or let the first headless request open the window):

| Command | Does |
| --- | --- |
| `/free-ai status` | Shows which providers are signed in |
| `/free-ai login qwen` | Opens the Qwen sign-in window in Chrome on the machine DSH runs on, and waits |
| `/free-ai logout qwen` | Forgets the Qwen session and its browser profile |

Provider names: `qwen`, `deepseek`, `kimi`, `zai`. With `autoSignIn: false` a request without a session fails at once and `/free-ai login` is the only way in.

## Configuration

```yaml
- id: free-ai
  config:
    providers: [qwen, deepseek, kimi, zai]   # routes to register
    autoSignIn: true                   # open the sign-in window when there is no session
    browserMode: auto                  # auto | headed | headless (Qwen and Z.ai bridges)
    loginTimeoutMs: 300000
    proxy: ""                          # e.g. http://host:3128 for the browser windows
    debug: false                       # DEBUG lines in the log
```

## Files

Everything lives under `~/.ai-free-vscode/dsh/`: the browser profiles (separate from the VS Code extension's, as Chrome opens a profile in one process at a time), `sessions.json` with the sign-ins (mode 600), and `free-ai.log`.

Kimi reaches for its own server-side `ipython`/`shell` on long sessions; such a call is stopped before Kimi runs it and handed to the harness's `bash` tool, or asked again.
