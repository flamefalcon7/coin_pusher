import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

/**
 * The game server uses NodeNext-style imports with explicit ".js" specifiers
 * that actually point at ".ts" sources (e.g. `import { Coin } from "./Coin.js"`).
 * Vite/Vitest does not remap these by default, so this plugin rewrites a
 * relative "*.js" import to its "*.ts" sibling when the .ts file exists.
 * Applies to both server src and the shared package.
 */
function resolveTsFromJs() {
  return {
    name: "resolve-ts-from-js",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) {
        return null;
      }
      const candidate = path.resolve(
        path.dirname(importer),
        source.slice(0, -3) + ".ts",
      );
      return fs.existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  plugins: [resolveTsFromJs()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
    // Rapier WASM init + full physics trials run far longer than the 5s default.
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@coin-pusher/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
