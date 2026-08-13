import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
    },
  },
  test: {
    // `describe` / `it` / `expect` available without importing, matching the
    // pre-existing lib/reconciliation-entity-validator.test.ts style.
    globals: true,
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    // These modules open real Postgres/Redis connections at import time.
    // Unit tests must stay hermetic; integration coverage is tracked separately.
    exclude: ["node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Only measure the modules we actually unit test. Pulling `all: true` in
      // would drag every route + generated shadcn component into the report and
      // bury the signal.
      include: ["lib/**/*.ts"],
      exclude: [
        "lib/**/*.test.ts",
        "lib/migrations/**",
        "lib/queue/**",
        "lib/state/types.ts",
      ],
    },
  },
})
