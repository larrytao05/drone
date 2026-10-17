import { mkdir, readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { draftFixture, importDraft, mapRegion, openBlankEditor } from './editor-helpers.js';

async function sourceBackup(page: Page): Promise<unknown> {
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const download = await downloadPending;
  const path = await download.path();
  if (path === null) throw new Error('Source backup must be downloadable');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

test('native local canvas locator, pan and zoom preserve exact source with no external requests', async ({ page }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('The managed local map test requires a configured base URL');
  const appOrigin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  const workerResponses: Array<{ url: string; status: number }> = [];
  page.context().on('response', (response) => {
    if (new URL(response.url()).pathname === '/maplibre-gl-worker.mjs') {
      workerResponses.push({ url: response.url(), status: response.status() });
    }
  });
  page.context().on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== appOrigin && url.protocol !== 'data:' && url.protocol !== 'blob:') {
      externalRequests.push(url.origin);
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBlankEditor(page);
  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('Map ready');
  await expect(map.locator('canvas')).toHaveCount(1);
  await importDraft(page, draftFixture());
  const before = await sourceBackup(page);

  await page.getByRole('textbox', { name: 'Locator latitude' }).fill('51.5074');
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill('-0.1278');
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(map.getByLabel('Map view')).toContainText('Center 51.5074, -0.1278');
  const canvas = map.locator('canvas').first();
  const viewBeforeDrag = await map.getByLabel('Map view').textContent();
  const centerBeforeDrag = viewBeforeDrag?.match(/^Center ([^·]+) · zoom /)?.[1];
  expect(centerBeforeDrag).toBeDefined();
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error('The native MapLibre canvas must be visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const view = await map.getByLabel('Map view').textContent();
    return view?.match(/^Center ([^·]+) · zoom /)?.[1];
  }).not.toBe(centerBeforeDrag);
  const viewAfterDrag = await map.getByLabel('Map view').textContent();
  const zoomBeforeWheel = Number(viewAfterDrag?.match(/zoom (\d+(?:\.\d+)?)/)?.[1]);
  await page.mouse.wheel(0, -180);
  await expect.poll(async () => {
    const view = await map.getByLabel('Map view').textContent();
    return Number(view?.match(/zoom (\d+(?:\.\d+)?)/)?.[1]);
  }).toBeGreaterThan(zoomBeforeWheel);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  expect(await sourceBackup(page)).toEqual(before);
  await expect(map.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  expect(externalRequests).toEqual([]);
  await expect.poll(() => workerResponses.length).toBeGreaterThan(0);
  expect(workerResponses.every(({ status }) => status === 200)).toBe(true);
  expect(workerResponses.every(({ url }) => new URL(url).origin === appOrigin)).toBe(true);

  await mkdir('/private/tmp/drone-stage2-s2-05-shots', { recursive: true });
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-05-shots/desktop.png', fullPage: true });

  await page.setViewportSize({ width: 320, height: 900 });
  await expect(map.locator('canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-05-shots/narrow.png', fullPage: true });

  const zoomBeforeNarrowClick = Number((await map.getByLabel('Map view').textContent())?.match(/zoom (\d+(?:\.\d+)?)/)?.[1]);
  await map.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => {
    const view = await map.getByLabel('Map view').textContent();
    return Number(view?.match(/zoom (\d+(?:\.\d+)?)/)?.[1]);
  }).toBeGreaterThan(zoomBeforeNarrowClick);

  const cameraBeforeInvalid = await map.getByLabel('Map view').textContent();
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill('91');
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill('0');
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(page.getByRole('textbox', { name: 'Locator latitude' })).toHaveAttribute('aria-invalid', 'true');
  await expect(map.getByRole('alert')).toContainText('Enter a value between -90 and 90.');
  await expect(map.getByLabel('Map view')).toHaveText(cameraBeforeInvalid ?? '');
  expect(await sourceBackup(page)).toEqual(before);
  expect(externalRequests).toEqual([]);
});
