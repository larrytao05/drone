import { defineConfig, devices } from '@playwright/test';

const production = process.env.MAP_PROVIDER_SERVER_MODE === 'production';
const mode = production ? 'start' : 'dev';
const providerPort = 3000;
const missingPort = 3001;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['map-navigation.spec.ts', 'map-provider-live.spec.ts'],
  workers: 1,
  reporter: 'line',
  outputDir: '/private/tmp/drone-stage2-provider-artifacts',
  preserveOutput: 'never',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${providerPort}`,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: [
    {
      command: `node scripts/run-map-server.mjs provider ${mode} ${providerPort}`,
      url: `http://127.0.0.1:${providerPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `node scripts/run-map-server.mjs missing ${mode} ${missingPort}`,
      url: `http://127.0.0.1:${missingPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
