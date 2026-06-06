# 🚀 AI Free VSCode

[![GitHub stars](https://img.shields.io/github/stars/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/AppsGanin/ai-free-vscode.svg)](https://github.com/AppsGanin/ai-free-vscode/network)
[![GitHub watchers](https://img.shields.io/github/watchers/AppsGanin/ai-free-vscode.svg?style=social)](https://github.com/AppsGanin/ai-free-vscode/watchers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS_Code-%5E1.105.0-success.svg)](https://code.visualstudio.com)

> Use free AI models directly in Copilot Chat without API keys, billing, or token counting.

**AI Free VSCode** connects free web-based models through a Playwright browser session and registers them as a Copilot Chat provider.

## What it does

- ✅ Integrates free Qwen, DeepSeek, and Kimi models into Copilot Chat
- ✅ Requires no API keys and does not use paid OpenAI endpoints
- ✅ Authenticates via a real browser session
- ✅ Supports streaming, automatic thinking mode, and tool calling
- ✅ Exposes models through a unified provider for VS Code
- ✅ Generates commit messages from your staged diff
- ✅ Inline code suggestions (ghost text) on demand
- ✅ "Fix with AI" Quick Fix on errors/warnings, with a diff preview

Only models from providers you are signed into appear in the picker — no
dead entries that fail on use.

## Supported models

### Qwen

| Model                  | ID                                   | Context |
| ---------------------- | ------------------------------------ | ------- |
| Qwen3.7 Max            | `qwen3.7-max`                        | 1M      |
| Qwen3.7 Max (Preview)  | `qwen-latest-series-invite-beta-v24` | 256K    |
| Qwen3.7 Plus (Preview) | `qwen-latest-series-invite-beta-v16` | 1M      |
| Qwen3.6 Plus           | `qwen3.6-plus`                       | 1M      |
| Qwen3.6 Max (Preview)  | `qwen3.6-max-preview`                | 256K    |
| Qwen3.6 Plus (Preview) | `qwen3.6-plus-preview`               | 1M      |
| Qwen3.6 27B            | `qwen3.6-27b`                        | 256K    |
| Qwen3.6 35B-A3B        | `qwen3.6-35b-a3b`                    | 256K    |
| Qwen3.5 Plus           | `qwen3.5-plus`                       | 1M      |
| Qwen3.5 Flash          | `qwen3.5-flash`                      | 1M      |
| Qwen3.5 Max (Preview)  | `qwen3.5-max-2026-03-08`             | 256K    |
| Qwen3.5 397B-A17B      | `qwen3.5-397b-a17b`                  | 256K    |
| Qwen3.5 122B-A10B      | `qwen3.5-122b-a10b`                  | 256K    |
| Qwen3.5 35B-A3B        | `qwen3.5-35b-a3b`                    | 256K    |
| Qwen3.5 27B            | `qwen3.5-27b`                        | 256K    |
| Qwen3 Max              | `qwen3-max-2026-01-23`               | 256K    |
| Qwen3 235B-A22B        | `qwen-plus-2025-07-28`               | 128K    |
| Qwen3 Coder            | `qwen3-coder-plus`                   | 1M      |
| Qwen3 VL 235B-A22B     | `qwen3-vl-plus`                      | 262K    |
| Qwen3 Omni Flash       | `qwen3-omni-flash-2025-12-01`        | 65K     |
| Qwen2.5 Max            | `qwen-max-latest`                    | 128K    |

### DeepSeek

| Model    | ID                 | Context |
| -------- | ------------------ | ------- |
| DeepSeek | `deepseek-default` | 128K    |

### Kimi

| Model     | ID          | Context |
| --------- | ----------- | ------- |
| Kimi K2.5 | `kimi-k2.5` | 128K    |

> ⚠️ **Tool calling is disabled for Kimi** (it is not advertised as a
> tool-capable model, so VS Code won't pick it for agent/tool turns). Instead of
> the text tool-call protocol, Kimi falls back to its built-in `ipython` code
> interpreter and runs a server-side agent loop we cannot feed results to —
> slow (often minutes) and unreliable. Use Kimi for plain chat; pick Qwen or
> DeepSeek when you need tools.

## How it works

1. The extension registers a single Copilot Chat provider: `ai-free-vscode`.
2. Signing in launches Playwright and stores the authenticated session in `SecretStorage`.
3. Requests are routed through private Qwen, DeepSeek, and Kimi API streams.
4. Responses are delivered to VS Code as streamed chunks.
5. The extension handles tool calling and thinking-mode when available.

## Installation

1. Download the latest `ai-free-vscode-*.vsix` from the Releases page.
2. In VS Code, open Extensions → `···` → **Install from VSIX...**.
3. Reload VS Code.

## Quick start

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
2. Run the sign-in command:
   - `AI Free VSCode — Sign In`
3. Choose a provider: Qwen, DeepSeek, Kimi.
4. Sign in with your browser and wait for success.
5. Open Copilot Chat and select a model.

To sign out:

- `AI Free VSCode — Sign Out`

To check auth status:

- `AI Free VSCode — Status`

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
- Pick a model quickly: command `AI Free VSCode — Select commit model`

### Inline suggestions (ghost text)

On-demand code completion at the cursor. It is **manual only** — it never fires
while typing.

- Trigger: `Ctrl+Alt+\` (Mac `Cmd+Alt+\`), or command
  `AI Free VSCode — Inline suggestion`, or the built-in *Trigger Inline Suggestion*
- Accept with `Tab`, dismiss with `Esc`
- Enable first: set `freeAI.suggestions.enabled` to `true` (the hotkey will offer
  to enable it)

> These backends run through a web session (DeepSeek also solves a PoW challenge),
> so expect noticeably higher latency than native Copilot.

### Fix with AI (Quick Fix)

When there is a red error or yellow warning, open the lightbulb (`Cmd+.` /
`Ctrl+.`) and choose **✨ Fix with AI Free**. The model rewrites the affected
lines (indentation is preserved) and shows a **diff preview** with Apply / Cancel
before changing the file.

- Toggle the action: `freeAI.fix.enabled`
- Model: `freeAI.fix.model`

## Configuration

| Setting                          | Default  | Description                                                  |
| -------------------------------- | -------- | ------------------------------------------------------------ |
| `freeAI.playwright.timeout`      | `120000` | Browser sign-in timeout in milliseconds                     |
| `freeAI.commit.model`            | `auto`   | Model for commit messages (`auto` = first available)        |
| `freeAI.commit.prompt`           | —        | Instruction prepended to the diff for commit generation     |
| `freeAI.suggestions.enabled`     | `false`  | Enable manual inline ghost-text suggestions                 |
| `freeAI.suggestions.model`       | `auto`   | Model for inline suggestions                                 |
| `freeAI.suggestions.maxPrefixChars` | `2000` | Chars of code before the cursor sent to the model           |
| `freeAI.suggestions.maxSuffixChars` | `800`  | Chars of code after the cursor sent to the model            |
| `freeAI.fix.enabled`             | `true`   | Show the "Fix with AI Free" Quick Fix on diagnostics        |
| `freeAI.fix.model`               | `auto`   | Model for fixing problems                                    |

Thinking (reasoning) is automatic: enabled in plain chat, disabled when tools are
active (reasoning is unreliable with tool calling on these backends).

## Development

```bash
git clone https://github.com/AppsGanin/ai-free-vscode
cd ai-free-vscode
npm install
# If you need local Chromium for development:
npx playwright install chromium
```

Run the extension in VS Code with `F5`.

## Project structure

- `src/extension.ts` — extension activation, command registration, provider wiring
- `src/logger.ts` — shared logging utility for extension output
- `src/providers/BaseAIProvider.ts` — abstract provider interface for all models
- `src/providers/types.ts` — shared AI request/response type definitions
- `src/providers/common/` — shared provider utilities (model resolver, Chromium guard, tool calling helpers)
- `src/providers/UnifiedProvider.ts` — unified provider combining Qwen + DeepSeek
- `src/providers/qwen/` — Qwen client, auth manager, and model definitions
- `src/providers/deepseek/` — DeepSeek client, auth manager, and model definitions
- `src/vscode/ProviderRegistry.ts` — registers the provider with VS Code LM API
- `src/vscode/VSCodeLMAdapter.ts` — adapter between VS Code LM API and providers
- `src/vscode/CommitMessageGenerator.ts` — commit message generation command
- `src/vscode/InlineCompletionProvider.ts` — manual inline ghost-text suggestions
- `src/vscode/FixProblemProvider.ts` — "Fix with AI" Quick Fix with diff preview
- `esbuild.js` — bundles source into `dist/extension.js`
- `package.json` — extension metadata, commands, and dependencies
- `tsconfig.json` — TypeScript configuration

## Requirements

- VS Code `^1.105.0`
- System Chrome or network access for Playwright to download Chromium
- Free Qwen or DeepSeek account for browser sign-in

## Important notice

This is an unofficial extension. Authentication is handled through a browser session, and the integration may break if providers change their web APIs or terms.

> Use at your own risk. Web session automation may violate provider policies.
