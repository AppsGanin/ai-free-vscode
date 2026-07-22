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

/** Сколько держим в памяти результат `mimo models` (список моделей меняется редко). */
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 20000;

let cachedBinary: { path: string | undefined; at: number } | undefined;
let cachedModels: { routes: string[]; at: number } | undefined;

/** Сбрасывает кэши (после логина/логаута/установки CLI). */
export function invalidateMimoCliCache(): void {
  cachedBinary = undefined;
  cachedModels = undefined;
}

/**
 * Нейтральная рабочая директория для всех вызовов CLI.
 *
 * Хост расширений стартует с cwd `/`, а mimocode отказывается работать в корне
 * ФС («filesystem root is not a valid project directory»). Проект пользователя
 * тоже не берём: индексировать его и создавать там сессии незачем.
 */
export async function mimoWorkDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "free-ai-vscode-mimo");
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Кандидаты на путь к бинарнику: настройка → штатный installer-путь → PATH. */
function binaryCandidates(): string[] {
  const candidates: string[] = [];

  const configured = vscode.workspace
    .getConfiguration("freeAI")
    .get<string>("mimo.path", "")
    .trim();
  if (configured) {
    candidates.push(configured);
  }

  const home = os.homedir();
  for (const name of BIN_NAMES) {
    candidates.push(path.join(home, ".mimocode", "bin", name));
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of BIN_NAMES) {
      candidates.push(path.join(dir, name));
    }
  }

  return candidates;
}

/**
 * Путь к исполняемому `mimo` или undefined, если CLI не установлен.
 * Результат кэшируется (в т.ч. отрицательный — на короткое время).
 */
export async function resolveMimoBinary(): Promise<string | undefined> {
  const now = Date.now();
  if (cachedBinary && now - cachedBinary.at < MODELS_CACHE_TTL_MS) {
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
 * Список моделей, которые CLI реально может дать (`mimo models` печатает
 * `providerID/modelID` по строке на модель). Пустой список = CLI не настроен.
 */
export async function listCliModelRoutes(
  force = false,
): Promise<string[]> {
  const now = Date.now();
  if (!force && cachedModels && now - cachedModels.at < MODELS_CACHE_TTL_MS) {
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

    // Это ВЕСЬ вывод CLI, а не то, что мы показываем: до списка расширения он
    // ещё фильтруется по MIMO_MODEL_ROUTES (остаётся только бесплатный канал).
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
 * Окружение для дочерних процессов CLI: гасим автообновление и всё, что
 * замедляет холодный старт и нам не нужно (скиллы, cron, импорт Claude Code).
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

/** Открывает терминал VS Code с командами CLI (логин/установка выполняются в нём). */
export function runInTerminal(name: string, ...commands: string[]): void {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show(true);
  for (const command of commands) {
    terminal.sendText(command, true);
  }
}
