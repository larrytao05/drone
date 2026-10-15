import { defineConfig, devices } from '@playwright/test';

const production = process.env.EDITOR_SERVER_MODE === 'production';
const port = production ? 3104 : 3103;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    'backup-foundation.spec.ts',
    'backups.spec.ts',
    'save-review.spec.ts',
    'load-storage.spec.ts',
    'reordering.spec.ts',
    'deletion.spec.ts',
    'preview.spec.ts',
    'route-settings.spec.ts',
    'coordinate-source.spec.ts',
    'new-route.spec.ts',
    'layout-accessibility.spec.ts',
    'local-map.spec.ts',
    'add-points.spec.ts',
    'selection.spec.ts',
    'coordinate-editing.spec.ts',
    'map-dragging.spec.ts',
  ],
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
  },
  webServer: {
    command: production
      ? `npm run build:web && npm run start:web -- --hostname 127.0.0.1 --port ${port}`
      : `npm run dev:web -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
