import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname localhost",
    url: "http://localhost:3000/en-us",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
