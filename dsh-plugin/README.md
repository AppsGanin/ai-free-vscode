# dsh-plugin-free-ai

Qwen, DeepSeek and Z.ai web chats as model providers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), signed in with your own browser account. The same provider core as the [AI Free VSCode](https://github.com/AppsGanin/ai-free-vscode) extension.

> Unofficial. It drives the providers' web chats the way their own web apps do; their terms of service apply, and a change on their side can break it until the plugin is updated.

## Install

```sh
dsh plugin --profile <name> add dsh-plugin-free-ai
```

## Use

Model routes: `qwen-web`, `deepseek-web`, `zai-web`. Point the agent at one in the profile's `cordis.patch.yml`:

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

The first request to a route without a session opens that provider's sign-in window; sign in once and the request continues. Qwen may also ask for a one-time captcha in a browser window.

## Configuration

```yaml
- id: free-ai
  config:
    providers: [qwen, deepseek, zai]   # routes to register
    autoSignIn: true                   # open the sign-in window when there is no session
    browserMode: auto                  # auto | headed | headless (Qwen and Z.ai bridges)
    loginTimeoutMs: 300000
    proxy: ""                          # e.g. http://host:3128 for the browser windows
    debug: false                       # DEBUG lines in the log
```

## Files

Everything lives under `~/.ai-free-vscode/dsh/`: the browser profiles (separate from the VS Code extension's, as Chrome opens a profile in one process at a time), `sessions.json` with the sign-ins (mode 600), and `free-ai.log`.

Kimi is not offered: its web chat does not handle agent tool calls reliably.
