import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/demo",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
