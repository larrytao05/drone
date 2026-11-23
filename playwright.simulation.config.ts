import { defineConfig, devices } from '@playwright/test';

const port = 3107;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['simulation-editor.spec.ts'],
  workers: 1,
  timeout: 180_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    video: 'off',
    screenshot: 'off',
    trace: 'off',
  },
  webServer: {
    command: `node scripts/run-map-server.mjs local dev ${port}`,
    env: {
      ...process.env,
      ENABLE_SIMULATION_BRIDGE: '1',
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
