import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    setupFiles: ["./tests/helpers/test-environment.ts"],
  },
});
