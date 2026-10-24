import { copyFileSync } from "node:fs";
import { build } from "esbuild";

// The provider core (../src/providers) is bundled in; playwright and the
// harness packages stay external: playwright is a dependency of this package,
// and the @deepseek-ai/* peers must be the running harness's own instances.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "lib/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  // The npm package carries the bundle only; the sources are on GitHub.
  sourcemap: false,
  external: ["playwright", "@deepseek-ai/*"],
  logLevel: "info",
  // The core reads this build-time switch; every provider is compiled in.
  define: { __ENABLED_PROVIDERS__: "undefined" },
});

// One licence for the repository; the package carries a copy.
copyFileSync("../LICENSE", "LICENSE");
