import { defineConfig, devices } from "@playwright/test";

const production = process.env.FOUNDATION_SERVER_MODE === "production";
const port = production ? 3102 : 3101;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "foundation.spec.ts",
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
  },
  webServer: {
    command: production
      ? `npm run start:web -- --hostname 127.0.0.1 --port ${port}`
      : `npm run dev:web -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
