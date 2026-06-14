const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

// ─── Build-time переключатели провайдеров ──────────────────────────────────
// Каждый провайдер можно отключить при сборке: PROVIDER_<NAME>=false.
// Примеры:
//   PROVIDER_QWEN=false npm run bundle        — собрать без Qwen
//   PROVIDER_KIMI=0 PROVIDER_QWEN=off npm ...   — без Kimi и Qwen
// По умолчанию включены все.
const ALL_PROVIDERS = ["qwen", "deepseek", "kimi"];

function isProviderEnabled(name) {
  const raw = process.env[`PROVIDER_${name.toUpperCase()}`];
  if (raw === undefined) {
    return true;
  }
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

const enabledProviders = ALL_PROVIDERS.filter(isProviderEnabled);
console.log(
  `[build] enabled providers: ${enabledProviders.join(", ") || "(none)"}`,
);

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "playwright"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: {
    __ENABLED_PROVIDERS__: JSON.stringify(enabledProviders),
  },
};

if (watch) {
  esbuild.context(buildOptions).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
