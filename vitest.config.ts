import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const live = process.env.LIVE === "1";

export default defineConfig({
  resolve: {
    // The extension runs inside VS Code; tests get a small stand-in.
    alias: {
      vscode: fileURLToPath(new URL("./test/mocks/vscode.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Live tests talk to the real services and need accounts: opt-in only.
    include: live ? ["test/live/**/*.test.ts"] : ["test/**/*.test.ts"],
    exclude: live ? [] : ["test/live/**"],
    testTimeout: live ? 240_000 : 10_000,
    hookTimeout: live ? 120_000 : 10_000,
    // Live tests share one browser profile per provider; never in parallel.
    fileParallelism: !live,
  },
});
