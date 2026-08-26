import { defineConfig, devices } from "@playwright/test";

import { buildE2eEnv, E2E_PORT } from "./e2e/env";

// Phone-sized end-to-end coverage for the capture-to-confirm path. Requires
// the Docker Compose services; never calls OpenAI (see e2e/global-setup.ts).

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  globalSetup: "./e2e/global-setup",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Pixel 7"],
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  // A production build in a dedicated distDir: Next allows only one dev
  // server per app directory, and e2e must not disturb a running `npm run
  // dev` session.
  webServer: {
    command: `npm run build && npm run start -- --port ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    // Playwright exports NODE_ENV=test to child processes, which makes Next
    // build against a non-production React; pin it back explicitly.
    env: {
      ...buildE2eEnv(),
      NEXT_DIST_DIR: ".next-e2e",
      NODE_ENV: "production",
    },
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
