import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const liveProviders = process.env.SIMULATION_LIVE_PROVIDERS === '1';
const port = Number(process.env.SIMULATION_PORT ?? (liveProviders ? 3110 : 3109));
if (liveProviders && !process.env.OPENROUTER_API_KEY?.trim()) {
  throw new Error('Full simulation verification requires OPENROUTER_API_KEY.');
}
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
    command: `node scripts/run-map-server.mjs ${liveProviders ? 'provider' : 'local'} dev ${port}`,
    env: {
      ...process.env,
      ENABLE_SIMULATION_BRIDGE: '1',
      DRONE_NEXT_DEV_DIST_DIR: liveProviders ? '.next-map-simulation-live' : '.next-map-simulation-local',
      ...(liveProviders ? {
        AGENT_LOGIN_PASSWORD: 'simulation-test-password',
        AGENT_SESSION_SECRET: randomBytes(32).toString('hex'),
        AGENT_ALLOWED_ORIGIN: baseURL,
        AGENT_MODEL_PROVIDER: 'openrouter',
        OPENROUTER_MODEL: 'openrouter/free',
      } : {}),
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
