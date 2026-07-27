import { execFile } from "child_process";
import { access, constants, mkdir } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";

const clog = createLogger("mimo-cli");
const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";
const BIN_NAMES = IS_WINDOWS ? ["mimo.cmd", "mimo.exe", "mimo"] : ["mimo"];

/** How long `mimo models` is cached — the list rarely changes. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 20000;

/**
 * Workbench action that opens a shell on the machine hosting the VS Code UI.
 * Registered only while a remote connection is open.
 */
const NEW_LOCAL_TERMINAL = "workbench.action.terminal.newLocal";
const RENAME_TERMINAL = "workbench.action.terminal.renameWithArg";
const LOCAL_TERMINAL_TIMEOUT_MS = 5000;

let cachedBinary: { path: string | undefined; at: number } | undefined;
let cachedModels: { routes: string[]; at: number } | undefined;

/** Drops the caches after a login/logout or a fresh CLI install. */
export function invalidateMimoCliCache(): void {
  cachedBinary = undefined;
  cachedModels = undefined;
}

/**
 * Neutral working directory for every CLI call.
 *
 * The extension host starts with cwd `/`, and mimocode refuses to run in the
 * filesystem root. The user's project is not used either: there is no reason to
 * index it or create sessions inside it.
 */
export async function mimoWorkDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "free-ai-vscode-mimo");
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}

/**
 * Path to an executable `mimo`, or undefined when the CLI is not installed.
 * The result is cached, including the negative one (briefly).
 */
export async function resolveMimoBinary(): Promise<string | undefined> {
  const now = Date.now();
  if (cachedBinary && now - cachedBinary.at < CACHE_TTL_MS) {
    return cachedBinary.path;
  }

  for (const candidate of binaryCandidates()) {
    if (await isExecutable(candidate)) {
      clog.debug(`binary resolved: ${candidate}`);
      cachedBinary = { path: candidate, at: now };
      return candidate;
    }
  }

  // The searched roots go into the log: in a remote window they describe the
  // local machine, which is the usual surprise in bug reports.
  const where = vscode.env.remoteName
    ? `local machine (window is ${vscode.env.remoteName})`
    : "local machine";
  clog.debug(
    `binary not found (mimo CLI is not installed?) searched the ${where}, home=${os.homedir()}`,
  );
  cachedBinary = { path: undefined, at: now };
  return undefined;
}

/**
 * Models the CLI can actually serve (`mimo models` prints one
 * `providerID/modelID` per line). An empty list means it is not set up.
 */
export async function listCliModelRoutes(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && cachedModels && now - cachedModels.at < CACHE_TTL_MS) {
    return cachedModels.routes;
  }

  const bin = await resolveMimoBinary();
  if (!bin) {
    cachedModels = { routes: [], at: now };
    return [];
  }

  try {
    const { stdout } = await execFileAsync(bin, ["models", "--pure"], {
      cwd: await mimoWorkDir(),
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: cliEnv(),
    });

    const routes = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+\/[\w.-]+$/.test(line));

    // This is the CLI's whole output, not what we expose: it is filtered
    // against MIMO_MODEL_ROUTES afterwards (only the free channel survives).
    clog.debug(`models reported by CLI: ${routes.join(", ") || "(none)"}`);
    cachedModels = { routes, at: now };
    return routes;
  } catch (err) {
    clog.warn(`models failed — ${errToString(err)}`);
    cachedModels = { routes: [], at: now };
    return [];
  }
}

/**
 * Environment for CLI child processes: disables auto-update and everything that
 * slows a cold start down without being useful here (skills, cron, imports).
 */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIMOCODE_DISABLE_AUTOUPDATE: "1",
    MIMOCODE_DISABLE_CRON: "1",
    MIMOCODE_DISABLE_BUILTIN_SKILLS: "1",
    MIMOCODE_DISABLE_CLAUDE_CODE: "1",
    MIMOCODE_CLIENT: "free-ai-vscode",
    ...extra,
  };
}

/**
 * Runs CLI commands in a terminal **on the machine the extension host lives on**.
 *
 * This matters in a Remote-SSH window: the extension is UI-only (the browser
 * sign-ins need a display), so it runs locally and only ever sees local
 * binaries — but a plain `createTerminal()` opens a shell on the *server*, which
 * used to install the CLI exactly where `resolveMimoBinary()` can never find it.
 *
 * Returns false when no local terminal could be opened; the commands are handed
 * to the user through the clipboard instead.
 */
export async function runInTerminal(
  name: string,
  ...commands: string[]
): Promise<boolean> {
  const terminal = await createLocalTerminal(name);
  if (!terminal) {
    await offerCommandsForLocalShell(commands);
    return false;
  }

  terminal.show(true);
  for (const command of commands) {
    terminal.sendText(command, true);
  }
  return true;
}

/** True when the CLI would be installed on a different machine than we look at. */
export function isRemoteWindow(): boolean {
  return Boolean(vscode.env.remoteName);
}

async function createLocalTerminal(
  name: string,
): Promise<vscode.Terminal | undefined> {
  if (!isRemoteWindow()) {
    return vscode.window.createTerminal({ name });
  }

  const available = await vscode.commands.getCommands(true);
  if (!available.includes(NEW_LOCAL_TERMINAL)) {
    clog.warn(
      `${NEW_LOCAL_TERMINAL} is unavailable — cannot reach a local shell`,
    );
    return undefined;
  }

  // A workbench action returns nothing, so the new terminal has to be caught
  // through the open event.
  let subscription: vscode.Disposable | undefined;
  const opened = new Promise<vscode.Terminal | undefined>((resolve) => {
    subscription = vscode.window.onDidOpenTerminal((terminal) =>
      resolve(terminal),
    );
    setTimeout(() => resolve(undefined), LOCAL_TERMINAL_TIMEOUT_MS);
  });

  try {
    await vscode.commands.executeCommand(NEW_LOCAL_TERMINAL);
    const terminal = await opened;
    if (!terminal) {
      clog.warn(`${NEW_LOCAL_TERMINAL} opened no terminal`);
      return undefined;
    }

    clog.debug(`local terminal opened in a ${vscode.env.remoteName} window`);
    // newLocal leaves the terminal active, so the rename lands on it.
    await vscode.commands
      .executeCommand(RENAME_TERMINAL, { name })
      .then(undefined, () => undefined);
    return terminal;
  } catch (err) {
    clog.warn(`local terminal failed — ${errToString(err)}`);
    return undefined;
  } finally {
    subscription?.dispose();
  }
}

/** Last resort: the user runs the commands in their own local shell. */
async function offerCommandsForLocalShell(commands: string[]): Promise<void> {
  const script = commands.join(" && ");
  const copy = "Copy Command";
  const choice = await vscode.window.showWarningMessage(
    "MiMo Code CLI has to be installed on the machine running the VS Code window, not on the remote host — this extension runs UI-side and only sees local binaries.",
    { modal: true, detail: `Run in a local terminal:\n\n${script}` },
    copy,
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(script);
  }
}

/** Candidate paths: the setting, then the installer location, then PATH. */
function binaryCandidates(): string[] {
  const candidates: string[] = [];

  const configured = vscode.workspace
    .getConfiguration("freeAI")
    .get<string>("mimo.path", "")
    .trim();
  if (configured) candidates.push(configured);

  const dirs = [
    path.join(os.homedir(), ".mimocode", "bin"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const name of BIN_NAMES) {
      candidates.push(path.join(dir, name));
    }
  }

  return candidates;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
