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
      ? `env -u MAPTILER_API_KEY -u NEXT_PUBLIC_MAPTILER_API_KEY DRONE_MAP_MODE=local DRONE_NEXT_DIST_DIR=.next sh -c 'npm run build:web && npm run start:web -- --hostname 127.0.0.1 --port ${port}'`
      : `node scripts/run-map-server.mjs local dev ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
