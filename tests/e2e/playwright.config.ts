import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "desktop.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["line"], ["html", { outputFolder: "../../playwright-report", open: "never" }]],
  outputDir: "../../test-results/electron",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000 },
});
