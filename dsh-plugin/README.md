# dsh-plugin-free-ai

Qwen, DeepSeek, Kimi and Z.ai web chats as model providers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), signed in with your own browser account. The same provider core as the [AI Free VSCode](https://github.com/AppsGanin/ai-free-vscode) extension.

> Unofficial. It drives the providers' web chats the way their own web apps do; their terms of service apply, and a change on their side can break it until the plugin is updated.

## Requirements

- DeepSeek Harness 0.2.x (`npm i -g @deepseek-ai/dsh`), Node.js 20 or newer.
- Google Chrome. The sign-in windows and the Qwen and Z.ai browser bridges run in your installed Chrome: the providers' anti-bot checks let it through, unlike an automated browser. Without Chrome the plugin falls back to Playwright's Chromium, which you then install with `npx playwright install chromium`.
- An account on each provider you use (free).

## Install

```sh
dsh plugin --profile <name> add dsh-plugin-free-ai
```

## Use

Model routes: `qwen-web`, `deepseek-web`, `kimi-web`, `zai-web`. Point the agent at one in the profile's `cordis.patch.yml`:

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

The first request to a route without a session opens that provider's sign-in window; sign in once and the request continues. Qwen may also ask for a captcha in a browser window now and then, more often for a new profile.

Models: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus` (Qwen); `deepseek-default`, `deepseek-expert` (DeepSeek); `kimi-instant` (Kimi); `glm-5.3`, `glm-5.2`, `glm-5.3-flash`, `glm-4.7` (Z.ai). The harness model picker lists them per route.

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
