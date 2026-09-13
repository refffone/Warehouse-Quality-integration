import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// This sandbox pre-installs Chromium outside Playwright's own managed
// browser cache (see PLAYWRIGHT_BROWSERS_PATH in the environment) — reuse
// it when present instead of trying to download a browser, but fall back
// to Playwright's normal managed browser on any machine where that path
// doesn't exist (a contributor's laptop, a future CI runner).
const sandboxChromium = "/opt/pw-browsers/chromium";
const executablePath = existsSync(sandboxChromium) ? sandboxChromium : undefined;

/** E2E suite drives a real wrangler dev + local D1 instance (see
 *  tests/e2e/global-setup.ts, which wipes local D1, re-applies every
 *  migration, and boots the server) rather than mocking anything — so
 *  tests run serially against one shared backend, same as a single
 *  person clicking through the app. */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:8787",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } },
    },
  ],
});
