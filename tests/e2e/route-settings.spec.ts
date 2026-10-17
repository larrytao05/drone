import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

test('shared settings apply to all calculated points and incomplete settings clear calculation', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('40');
  const calculated = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  await expect(calculated).toHaveCount(2);
  for (const index of [0, 1]) await expect(calculated.nth(index).getByRole('cell', { name: '40', exact: true })).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Heading', exact: true }).fill('360');
  await expect(calculated).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Heading', exact: true }).fill('90');
  await expect(calculated).toHaveCount(2);
});

test('framing branch changes start blank and inactive values are discarded', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const framing = page.getByRole('combobox', { name: 'Framing' });
  await expect(page.getByRole('button', { name: 'Set target' })).toBeDisabled();
  await framing.selectOption('face-target');
  for (const name of ['Target latitude', 'Target longitude', 'Target height']) await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Heading', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set target' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Target latitude', exact: true }).fill('37.776');
  await framing.selectOption('fixed');
  await expect(page.getByRole('textbox', { name: 'Heading', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Gimbal pitch' })).toHaveValue('');
  await framing.selectOption('face-target');
  await expect(page.getByRole('textbox', { name: 'Target latitude', exact: true })).toHaveValue('');
});

test('manual takeoff source stays separate from the route and remains editable at 320 pixels', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const latitude = page.getByRole('textbox', { name: 'Takeoff latitude' });
  const longitude = page.getByRole('textbox', { name: 'Takeoff longitude' });
  const takeoffRequirements = page.getByRole('region', { name: 'Takeoff requirements' });
  const table = page.getByRole('table', { name: 'Calculated waypoints' });
  const routeRows = await rows(page).allTextContents();
  const calculatedRows = await table.locator('tbody tr').allInnerTexts();

  await expect(latitude).toHaveValue('37.7740');
  await expect(longitude).toHaveValue('-122.4200');
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-08-settings-desktop.png' });
  await latitude.fill('-');
  await expect(takeoffRequirements).toContainText('Latitude: Enter a complete finite decimal number.');
  await latitude.fill('91');
  await expect(takeoffRequirements).toContainText('Latitude: Enter a value between -90 and 90.');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(await table.locator('tbody tr').allInnerTexts()).toEqual(calculatedRows);
  await expect(await rows(page).allTextContents()).toEqual(routeRows);

  await latitude.fill('37.7741');
  await expect(takeoffRequirements).toHaveCount(0);
  await expect(longitude).toHaveValue('-122.4200');
  await latitude.fill('');
  await expect(longitude).toHaveValue('-122.4200');
  await longitude.fill('');
  await expect(latitude).toHaveValue('');
  await expect(longitude).toHaveValue('');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(await table.locator('tbody tr').allInnerTexts()).toEqual(calculatedRows);
  await expect(await rows(page).allTextContents()).toEqual(routeRows);

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('textbox', { name: 'Takeoff latitude' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Takeoff longitude' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-08-settings-narrow.png', fullPage: true });
});

test('manual target source fields update the active branch without changing takeoff or waypoint order', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const framing = page.getByRole('combobox', { name: 'Framing' });
  await framing.selectOption('face-target');
  const targetLatitude = page.getByRole('textbox', { name: 'Target latitude', exact: true });
  const targetLongitude = page.getByRole('textbox', { name: 'Target longitude', exact: true });
  const targetHeight = page.getByRole('textbox', { name: 'Target height' });
  await expect(targetLatitude).toHaveValue('');
  await expect(targetLongitude).toHaveValue('');
  await expect(targetHeight).toHaveValue('');

  const originalRows = await rows(page).allTextContents();
  await targetLatitude.fill('37.776');
  await targetLongitude.fill('-122.419');
  await targetHeight.fill('10');
  await expect(targetLatitude).toHaveValue('37.776');
  await expect(targetLongitude).toHaveValue('-122.419');
  await expect(targetHeight).toHaveValue('10');
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await expect(await rows(page).allTextContents()).toEqual(originalRows);
  await expect(page.getByRole('textbox', { name: 'Takeoff latitude' })).toHaveValue('37.7740');
  await expect(page.getByRole('textbox', { name: 'Takeoff longitude' })).toHaveValue('-122.4200');
});

test('Set target changes the target only and retains its entered height', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } }));
  await locate(page, { latitude: 51.5074, longitude: -0.1278 });
  await page.getByRole('button', { name: 'Set target' }).click();
  await mapRegion(page).locator('canvas').first().click();
  await expect(async () => {
    expect(Number(await page.getByRole('textbox', { name: 'Target latitude', exact: true }).inputValue())).toBeCloseTo(51.5074, 4);
    expect(Number(await page.getByRole('textbox', { name: 'Target longitude', exact: true }).inputValue())).toBeCloseTo(-0.1278, 4);
  }).toPass({ timeout: 5000 });
  await expect(page.getByRole('textbox', { name: 'Target height', exact: true })).toHaveValue('10');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Takeoff latitude' })).toHaveValue('37.7740');
});
