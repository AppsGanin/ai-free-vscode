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

  clog.debug("binary not found (mimo CLI is not installed?)");
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

/** Opens a VS Code terminal running the given CLI commands (install/setup). */
export function runInTerminal(name: string, ...commands: string[]): void {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show(true);
  for (const command of commands) {
    terminal.sendText(command, true);
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
