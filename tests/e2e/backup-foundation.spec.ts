import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, openBlankEditor } from './editor-helpers.js';

test('downloads a versioned JSON backup and imports the downloaded source', async ({ page }) => {
  await openBlankEditor(page);
  const source = draftFixture({
    name: 'Raw source round trip',
    height: '3.',
    points: [{ id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '-', longitude: '' } }],
    framing: { kind: 'fixed', heading: '', pitch: '-.' },
    takeoff: null,
  });
  await importDraft(page, source);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Backup download has no readable file');
  const contents = await readFile(path, 'utf8');
  expect(JSON.parse(contents)).toEqual({ version: 1, draft: source });

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Import backup').setInputFiles(path);
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(source.name);
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue(source.height);
  await expect(page.getByRole('status', { name: 'Review status' })).toContainText(/not reviewed/i);
});

test('renders imported text as text without injecting HTML', async ({ page }) => {
  await openBlankEditor(page);
  const name = '<img src="x" onerror="window.routeInjected=true">';
  await importDraft(page, draftFixture({ name }));
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'routeInjected'))).toBeUndefined();
});
