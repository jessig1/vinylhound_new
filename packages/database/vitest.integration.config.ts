import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["src/**/*.integration.ts"],
    testTimeout: 10_000,
  },
});
