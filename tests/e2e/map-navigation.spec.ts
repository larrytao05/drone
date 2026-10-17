import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows, selectWaypoint } from './editor-helpers.js';

async function backup(page: Page): Promise<unknown> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('Backup must be downloadable');
  const result: unknown = JSON.parse(await readFile(path, 'utf8'));
  return result;
}

test('locating, panning and zooming preserve the mission source', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const before = await backup(page);
  await locate(page, { latitude: 51.5074, longitude: -0.1278 });
  const map = mapRegion(page);
  const box = await map.locator('canvas').first().boundingBox();
  if (!box) throw new Error('Map canvas must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, -200);
  expect(await backup(page)).toEqual(before);
  await expect(rows(page)).toHaveCount(2);
  await expect(map.getByText(/maptiler/i).first()).toBeVisible();
});

test('invalid locator input stays editable and does not change mission source', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const before = await backup(page);
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill('91');
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill('0');
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(page.getByRole('textbox', { name: 'Locator latitude' })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('textbox', { name: 'Locator latitude' })).toHaveValue('91');
  expect(await backup(page)).toEqual(before);
});

async function assertUsableWithoutMap(page: Page) {
  await importDraft(page, draftFixture());
  await expect(page.getByRole('status', { name: 'Map status' })).toHaveText(/unavailable|error|failed|missing/i);
  await selectWaypoint(page, 1).click();
  await page.getByRole('textbox', { name: 'Selected latitude' }).fill('37.8');
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/^saved$/i);
}

test('tile-provider failure preserves coordinate editing, preview and Save', async ({ page }) => {
  await page.route('**/api.maptiler.com/**', (route) => route.abort());
  await openBlankEditor(page);
  await assertUsableWithoutMap(page);
});

test('WebGL failure preserves coordinate editing, preview and Save', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: function (this: HTMLCanvasElement, type: string, options?: unknown) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [type, options]);
    } });
  });
  await openBlankEditor(page);
  await assertUsableWithoutMap(page);
});

test.describe('Application started without a map key', () => {
  test.use({ baseURL: process.env.DRONE_NO_MAP_BASE_URL ?? 'http://127.0.0.1:3001' });
  test('missing credentials preserve non-map editing and Save', async ({ page }) => {
    await openBlankEditor(page);
    await assertUsableWithoutMap(page);
  });
});
