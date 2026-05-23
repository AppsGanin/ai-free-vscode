# 🚀 AI Free VSCode

[![GitHub stars](https://img.shields.io/github/stars/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/network)
[![GitHub watchers](https://img.shields.io/github/watchers/AppsGanin/ai-free-vscode.svg?style=social)](https://github.com/AppsGanin/ai-free-vscode/watchers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS_Code-%5E1.103.0-success.svg)](https://code.visualstudio.com)
[![Last Commit](https://img.shields.io/github/last-commit/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/commits/main)

> **Tired of managing API keys, paying per token, and hitting rate limits?**
> There's a better way.

**AI Free VSCode** brings powerful AI models directly into VS Code Copilot Chat — using your existing **free web account**. No API keys. No billing. No token counting. Just sign in once through a browser and start chatting.

- ✅ **Zero cost** — uses the same free tier you already get on the website
- ✅ **No API keys** — authentication works through a real browser session (Playwright)
- ✅ **Native VS Code integration** — models appear directly in Copilot Chat model picker
- ✅ **Agent mode support** — full tool calling, file reads, multi-step tasks
- 🔄 **Auto-updates** — stays compatible with latest DeepSeek/Qwen APIs

Sign in once. Use forever.

## 🤖 Models

| Model              | ID                 | Description                      |
| ------------------ | ------------------ | -------------------------------- |
| DeepSeek V4        | `deepseek-default` | Default model, fast              |
| DeepSeek V4 Expert | `deepseek-expert`  | Extended reasoning               |
| Qwen2.5-Max        | `qwen-max`         | Powerful, complex tasks          |
| Qwen3.6-Plus       | `qwen-plus`        | Balanced, 1M context             |
| Qwen3-Max          | `qwen3-max`        | Flagship Qwen model              |
| Qwen3-Coder        | `qwen-coder`       | Specialized for code, 1M context |
| Qwen3.5-Flash      | `qwen-flash`       | Fastest Qwen model               |

## 🔧 How It Works

**Flow:**

1. User selects a model in Copilot Chat
2. Request routed to appropriate provider
3. Playwright loads stored browser session with cookies
4. API requests sent with proper authentication headers
5. SSE stream provides real-time response
6. Response displayed directly in VS Code interface

## Installation

1. Go to the [Releases](https://github.com/AppsGanin/ai-free-vscode/releases) page and download the latest `ai-free-vscode-*.vsix`.
2. In VS Code: **Extensions** panel → `···` menu → **Install from VSIX...** → select the file.
3. Reload VS Code when prompted.

> Chromium is bundled inside the package — no extra setup required.

## Getting started

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
2. Run **AI Free VSCode: "Provider": Sign In (Playwright)**
3. A browser window opens — sign in to your account normally.
4. The window closes automatically once the session is captured.
5. The model is now available in Copilot Chat — select it from the model picker.

To sign out run **AI Free VSCode: "Provider": Sign Out**.

## Configuration

| Setting                | Default | Description                             |
| ---------------------- | ------- | --------------------------------------- |
| `ai-free-vscode.debug` | `false` | Enable debug logging to VS Code console |

_AI Free VSCode in action within VS Code Copilot Chat_

## ⚙️ Requirements

- **VS Code** 1.103.0 or higher
- **Free** LLM provider account
- **Playwright Chromium** (automatically bundled with the extension)

## ❓ FAQ

### Why is this free?

We use your existing free LLM provider account through Playwright browser session. No API keys or paid subscriptions.

### Is it safe?

Authentication happens through a real browser. Session stored locally only with you. We don't store your credentials.

### Does this work permanently?

May stop working if the LLM provider changes their authentication or APIs. Project maintained by enthusiasts.

### Can I use my corporate account?

Yes, but make sure it's allowed by your company policy.

### Are there message limits?

Depends on your free tier on the website. Usually very high or unlimited.

### Can I use multiple accounts?

No, extension supports one active session at a time. To switch, sign out and in again.

### How do I update?

Download the latest VSIX from Releases and install it over the existing extension.

## 🏗 Development

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

## Support / Donate

If you find this useful and want to support development, any donation is appreciated.

Crypto wallets:

| Network | Token | Address                                            |
| ------- | ----- | -------------------------------------------------- |
| TRC20   | USDT  | `TJwyrPVEZVZ1YrcmDiZTyFjLo3Q2DmEGzs`               |
| ERC20   | USDT  | `0xf9d663146ce902da91911b214c71cc73a5269d1d`       |
| Solana  | USDT  | `2qAZRTbaUMTfYuZbD1dCYHjkYgxkw4dUYE9XY3JhC2Cs`     |
| TON     | USDT  | `UQDoat731MLYuIw8ayL3Vhhw7zTBbLvRaQFmDvab--CNNI7e` |

## 🤝 Contributing

Contributions are welcome! Please read our [Contribution Guide](CONTRIBUTING.md) first.

Some areas where you can help:

- Fix bugs (see [open issues](https://github.com/AppsGanin/ai-free-vscode/issues))
- Improve documentation
- Add new AI models or providers
- Enhance UI/UX
- Write tests

## 🧩 Tech Stack

- **Language**: JavaScript (ES Modules)
- **Framework**: VS Code Extension API
- **Browser Automation**: Playwright
- **Streaming**: Server-Sent Events (SSE)
- **Package Manager**: npm

## ⚠️ Legal Disclaimer

This extension is an independent, unofficial tool and is not affiliated with, endorsed by, or sponsored by any AI provider.

**Use at your own risk.** Automating web sessions may violate the Terms of Service of the respective platforms. Your account may be rate-limited, restricted, or banned as a result.

Always check the Terms of Service of the platforms you use.

## Disclaimer

This extension is an independent, unofficial tool and is not affiliated with, endorsed by, or sponsored by any AI provider.

- **Use at your own risk.** Automating web sessions may violate the Terms of Service of the respective platforms. Your account may be rate-limited, restricted, or banned as a result.
- **No guarantees.** The extension may stop working at any time if providers change their APIs, authentication flows, or access policies.
- **No liability.** The authors are not responsible for any consequences arising from the use of this extension, including but not limited to account suspension, data loss, or service interruptions.

Always check the Terms of Service of the platforms you use.
