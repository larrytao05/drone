import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, locate, mapRegion, openBlankEditor, selectWaypoint } from './editor-helpers.js';

test('provider tiles render and native source attribution stays visible at 320px and 1024px', async ({ page }) => {
  let successfulImageTiles = 0;
  page.on('response', (response) => {
    if (new URL(response.url()).hostname === 'api.maptiler.com'
      && /\/tiles\/satellite-v2\/\d+\/\d+\/\d+\.jpg$/.test(new URL(response.url()).pathname)
      && response.ok()) successfulImageTiles += 1;
  });

  await page.setViewportSize({ width: 1024, height: 900 });
  await openBlankEditor(page);
  const map = mapRegion(page);
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('Map ready');
  await expect.poll(() => successfulImageTiles).toBeGreaterThan(0);

  const canvas = map.locator('canvas').first();
  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) throw new Error('The provider map canvas must be visible');
  const screenshot = await page.screenshot({ animations: 'disabled' });
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The provider viewport must be configured');
  const renderedColors = await page.evaluate(async ({ encodedImage, frame, viewportSize }) => {
    const binary = atob(encodedImage);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = image.width;
    imageCanvas.height = image.height;
    const context = imageCanvas.getContext('2d');
    if (context === null) return 0;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Set<string>();
    const scaleX = image.width / viewportSize.width;
    const scaleY = image.height / viewportSize.height;
    for (let y = 8; y < frame.height; y += 24) {
      for (let x = 8; x < frame.width; x += 24) {
        const offset = (Math.floor((frame.y + y) * scaleY) * image.width + Math.floor((frame.x + x) * scaleX)) * 4;
        colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      }
    }
    return colors.size;
  }, { encodedImage: screenshot.toString('base64'), frame: canvasBox, viewportSize: viewport });
  expect(renderedColors).toBeGreaterThan(100);

  const attribution = map.locator('.maplibregl-ctrl-attrib');
  await expect(attribution).toContainText(/MapTiler/i);
  await expect(attribution).toContainText(/OpenStreetMap/i);
  const navigation = map.locator('.maplibregl-ctrl-bottom-right');
  await expect(navigation.getByRole('button', { name: 'Zoom in' })).toBeVisible();

  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(attribution).toBeVisible();
    const attributionBox = await attribution.boundingBox();
    const navigationBox = await navigation.boundingBox();
    const frameBox = await canvas.evaluate((element) => {
      const frame = element.parentElement;
      if (frame === null) return null;
      const { x, y, width: frameWidth, height: frameHeight } = frame.getBoundingClientRect();
      return { x, y, width: frameWidth, height: frameHeight };
    });
    expect(attributionBox).not.toBeNull();
    expect(navigationBox).not.toBeNull();
    expect(frameBox).not.toBeNull();
    if (attributionBox === null || navigationBox === null || frameBox === null) throw new Error('Map controls must have visible bounds');
    expect(attributionBox.x).toBeGreaterThanOrEqual(frameBox.x);
    expect(attributionBox.x + attributionBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
    expect(attributionBox.x + attributionBox.width).toBeLessThanOrEqual(navigationBox.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('a tile failure after successful imagery load removes the map and preserves editing', async ({ page }) => {
  let failTiles = false;
  let successfulImageTiles = 0;
  page.on('response', (response) => {
    if (/\/tiles\/satellite-v2\/\d+\/\d+\/\d+\.jpg$/.test(new URL(response.url()).pathname)
      && response.ok()) successfulImageTiles += 1;
  });
  await page.route('https://api.maptiler.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (failTiles && /\/tiles\/satellite-v2\/\d+\/\d+\/\d+\.jpg$/.test(url.pathname)) await route.abort();
    else await route.continue();
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await openBlankEditor(page);
  const map = mapRegion(page);
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('Map ready');
  await expect(map.locator('.maplibregl-ctrl-attrib')).toContainText(/MapTiler/i);
  await expect.poll(() => successfulImageTiles).toBeGreaterThan(0);
  failTiles = true;
  await locate(page, { latitude: 51.5074, longitude: -0.1278 });
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('unavailable');
  await importDraft(page, draftFixture());
  await selectWaypoint(page, 1).click();
  await page.getByRole('textbox', { name: 'Selected latitude' }).fill('37.8');
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/^saved$/i);
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('unavailable');
  await expect(map.getByRole('textbox', { name: 'Locator latitude' })).toBeEditable();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});
