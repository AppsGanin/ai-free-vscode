# AI Free VSCode

> **Tired of managing API keys, paying per token, and hitting rate limits?**
> There's a better way.

**AI Free VSCode** brings powerful AI models directly into VS Code Copilot Chat — using your existing **free web account**. No API keys. No billing. No token counting. Just sign in once through a browser and start chatting.

- ✅ **Zero cost** — uses the same free tier you already get on the website
- ✅ **No API keys** — authentication works through a real browser session
- ✅ **Native VS Code integration** — models appear directly in Copilot Chat model picker
- ✅ **Agent mode support** — full tool calling, file reads, multi-step tasks

Sign in once. Use forever.

## Models

| Model              | ID                 | Description                      |
| ------------------ | ------------------ | -------------------------------- |
| DeepSeek V4        | `deepseek-default` | Default model, fast              |
| DeepSeek V4 Expert | `deepseek-expert`  | Extended reasoning               |
| Qwen2.5-Max        | `qwen-max`         | Powerful, complex tasks          |
| Qwen3.6-Plus       | `qwen-plus`        | Balanced, 1M context             |
| Qwen3-Max          | `qwen3-max`        | Flagship Qwen model              |
| Qwen3-Coder        | `qwen-coder`       | Specialized for code, 1M context |
| Qwen3.5-Flash      | `qwen-flash`       | Fastest Qwen model               |

## Installation

1. Go to the [Releases](../../releases) page and download the latest `ai-free-vscode-*.vsix`.
2. In VS Code: **Extensions** panel → `···` menu → **Install from VSIX...** → select the file.
3. Reload VS Code when prompted.

> Chromium is bundled inside the package — no extra setup required.

## Getting started

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
2. Run **AI Free VSCode: DeepSeek: Sign In (Playwright)** or **AI Free VSCode: Qwen: Sign In (Playwright)**.
3. A browser window opens — sign in to your account normally.
4. The window closes automatically once the session is captured.
5. The model is now available in Copilot Chat — select it from the model picker.

To sign out run **AI Free VSCode: DeepSeek: Sign Out** / **AI Free VSCode: Qwen: Sign Out**.

## Configuration

| Setting                | Default | Description                             |
| ---------------------- | ------- | --------------------------------------- |
| `ai-free-vscode.debug` | `false` | Enable debug logging to VS Code console |

## Requirements

- VS Code 1.103.0 or higher
- A free DeepSeek or Qwen account

## Development

```bash
git clone https://github.com/AppsGanin/ai-free-vscode
cd ai-free-vscode
npm install   # also downloads Playwright Chromium
```

Press `F5` in VS Code to launch the extension in an Extension Development Host window.

Alternatively, symlink the project into the VS Code extensions folder to use it as a regular installed extension:

**macOS / Linux:**

```bash
ln -s /path/to/ai-free-vscode ~/.vscode/extensions/ai-free-vscode
```

**Windows (PowerShell, run as Administrator):**

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.vscode\extensions\ai-free-vscode" -Target "C:\path\to\ai-free-vscode"
```

Restart VS Code after running the command.

## About this project

This is a hobby project — built for fun and personal use.

Roughly half the code was written using this extension itself — a fitting feedback loop.

If you'd like to fix something, add a feature, or improve the integration — contributions and collaboration are very welcome. Open an issue or send a PR.

## License

MIT

## Disclaimer

This extension is an independent, unofficial tool and is not affiliated with, endorsed by, or sponsored by any AI provider.

- **Use at your own risk.** Automating web sessions may violate the Terms of Service of the respective platforms. Your account may be rate-limited, restricted, or banned as a result.
- **No guarantees.** The extension may stop working at any time if providers change their APIs, authentication flows, or access policies.
- **No liability.** The authors are not responsible for any consequences arising from the use of this extension, including but not limited to account suspension, data loss, or service interruptions.

Always check the Terms of Service of the platforms you use.
