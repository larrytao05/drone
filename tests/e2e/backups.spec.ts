import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, openBlankEditor } from './editor-helpers.js';

test('exports actual versioned source JSON and imports it without changing the local slot', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const source = draftFixture({
    name: '',
    height: '-',
    points: [{
      id: '11111111-1111-4111-8111-111111111111',
      coordinate: { latitude: '1e', longitude: '' },
    }],
    framing: { kind: 'fixed', heading: '-', pitch: '' },
    takeoff: null,
  });
  await importDraft(page, source);
  const slotBefore = await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)));
  expect(slotBefore.length).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Backup download has no readable file');
  const text = await readFile(path, 'utf8');
  expect(JSON.parse(text)).toEqual({ version: 1, draft: source });

  await page.getByRole('button', { name: 'New' }).click();
  await importDraft(page, source);
  expect(await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)))).toEqual(slotBefore);
  await expect(page.getByRole('status', { name: 'Review status' })).toContainText(/not reviewed|unreviewed/i);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('imports a valid complete source with selection cleared and fresh review required', async ({ page }) => {
  await openBlankEditor(page);
  const source = draftFixture();
  await importDraft(page, source);
  await page.getByRole('region', { name: 'Waypoints' }).getByRole('listitem').nth(0).click();
  await expect(page.getByRole('textbox', { name: 'Selected latitude' })).toHaveValue('37.7749');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
  await page.getByRole('button', { name: 'Add points' }).click();

  await importDraft(page, source);

  await expect(page.getByRole('textbox', { name: 'Selected latitude' })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Review status' })).toContainText(/not reviewed|unreviewed/i);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('imported source text cannot inject HTML', async ({ page }) => {
  await openBlankEditor(page);
  const name = '<img src="x" onerror="window.routeInjected=true">';
  await importDraft(page, draftFixture({ name }));
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'routeInjected'))).toBeUndefined();
});
