import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { draftFixture, importDraft, rows, selectWaypoint } from './editor-helpers.js';

test('selected coordinate errors preserve raw source and clear when corrected', async ({ page }) => {
  const source = draftFixture();
  const secondPoint = source.points[1];
  if (!secondPoint) throw new Error('Coordinate fixture needs a second waypoint');
  await page.goto('/');
  await importDraft(page, source);
  await selectWaypoint(page, 1).click();

  const card = page.getByRole('region', { name: 'Selected waypoint' });
  const latitude = page.getByRole('textbox', { name: 'Selected latitude' });
  const longitude = page.getByRole('textbox', { name: 'Selected longitude' });
  const calculatedRows = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  await expect(calculatedRows).toHaveCount(2);

  await latitude.fill('91');
  await longitude.fill('-');
  await expect(latitude).toHaveAttribute('aria-invalid', 'true');
  await expect(longitude).toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByRole('alert')).toContainText('Enter a value between -90 and 90.');
  await expect(card.getByRole('alert')).toContainText('Enter a complete finite decimal number.');
  await expect(calculatedRows).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  const screenshotDirectory = process.env.DRONE_S2_06_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    await page.screenshot({ path: join(screenshotDirectory, 'invalid-coordinate-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(screenshotDirectory, 'invalid-coordinate-320.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  await selectWaypoint(page, 2).click();
  await expect(page.getByRole('textbox', { name: 'Selected latitude' })).toHaveValue(secondPoint.coordinate.latitude);
  await expect(page.getByRole('textbox', { name: 'Selected longitude' })).toHaveValue(secondPoint.coordinate.longitude);
  await selectWaypoint(page, 1).click();
  await expect(latitude).toHaveValue('91');
  await expect(longitude).toHaveValue('-');

  await latitude.fill('37.7750');
  await longitude.fill('-122.4194');
  await expect(latitude).not.toHaveAttribute('aria-invalid', 'true');
  await expect(longitude).not.toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(calculatedRows).toHaveCount(2);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(source.name);
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue(source.height);
  if (screenshotDirectory) {
    await page.screenshot({ path: join(screenshotDirectory, 'corrected-coordinate-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: join(screenshotDirectory, 'corrected-coordinate-320.png'), fullPage: true });
  }
});
