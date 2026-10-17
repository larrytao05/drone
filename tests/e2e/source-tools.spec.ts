import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

test('takeoff and target markers track projectable source and ignore route editing', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  const takeoff = map.getByRole('button', { name: 'Takeoff', exact: true });
  const target = map.getByRole('button', { name: 'Target', exact: true });
  const takeoffLatitude = page.getByRole('textbox', { name: 'Takeoff latitude' });
  const targetLatitude = page.getByRole('textbox', { name: 'Target latitude', exact: true });
  const targetLongitude = page.getByRole('textbox', { name: 'Target longitude', exact: true });
  const targetHeight = page.getByRole('textbox', { name: 'Target height' });
  const framing = page.getByRole('combobox', { name: 'Framing' });
  const pointOne = map.getByRole('button', { name: 'Waypoint 1', exact: true });
  const pointTwo = map.getByRole('button', { name: 'Waypoint 2', exact: true });

  await expect(takeoff).toBeVisible();
  await expect(target).toHaveCount(0);
  await takeoffLatitude.fill('91');
  await expect(takeoff).toHaveCount(0);
  await takeoffLatitude.fill('37.7741');
  await expect(takeoff).toBeVisible();

  await framing.selectOption('face-target');
  await targetLatitude.fill('37.7743');
  await targetLongitude.fill('-122.4180');
  await targetHeight.fill('14');
  await expect(target).toBeVisible();
  const originalRows = await rows(page).allTextContents();
  const calculated = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  const originalCalculation = await calculated.allInnerTexts();
  expect(originalCalculation).toHaveLength(2);

  await expectMarkerInCanvas(page, takeoff, 'Takeoff');
  await expectMarkerInCanvas(page, target, 'Target');
  await expectMarkerInCanvas(page, pointOne, 'Waypoint 1');
  await expectMarkerInCanvas(page, pointTwo, 'Waypoint 2');
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-08-reference-tools-desktop.png' });

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(takeoff).toBeVisible();
  await expect(target).toBeVisible();
  await expectMarkerInCanvas(page, takeoff, 'Takeoff');
  await expectMarkerInCanvas(page, target, 'Target');
  await expectMarkerInCanvas(page, pointOne, 'Waypoint 1');
  await expectMarkerInCanvas(page, pointTwo, 'Waypoint 2');
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-08-reference-tools-narrow.png', fullPage: true });

  await page.getByRole('button', { name: 'Add points' }).click();
  await takeoff.click();
  await target.click();
  await expect(rows(page)).toHaveCount(2);
  await expect(await rows(page).allTextContents()).toEqual(originalRows);
  await expect(await calculated.allInnerTexts()).toEqual(originalCalculation);
  await expect(takeoffLatitude).toHaveValue('37.7741');
  await expect(targetLatitude).toHaveValue('37.7743');
  await expect(targetLongitude).toHaveValue('-122.4180');
  await expect(targetHeight).toHaveValue('14');
  await expect(page.getByRole('region', { name: 'Selected waypoint' })).toContainText('Select a waypoint');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);

  await targetLatitude.fill('91');
  await expect(target).toHaveCount(0);
  await framing.selectOption('fixed');
  await expect(target).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Target latitude', exact: true })).toHaveCount(0);
  await expect(takeoff).toBeVisible();
});

async function expectMarkerInCanvas(
  page: import('@playwright/test').Page,
  marker: import('@playwright/test').Locator,
  accessibleName: string,
) {
  const markerBox = await marker.boundingBox();
  const canvasBox = await mapRegion(page).getByLabel('Map canvas').boundingBox();
  if (markerBox === null || canvasBox === null) throw new Error(`${accessibleName} and the map canvas must be visible`);
  expect(markerBox.x).toBeGreaterThanOrEqual(canvasBox.x);
  expect(markerBox.y).toBeGreaterThanOrEqual(canvasBox.y);
  expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
  expect(markerBox.y + markerBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return {
      name: element?.closest('button')?.getAttribute('aria-label'),
      target: element?.outerHTML.slice(0, 200),
      stack: document.elementsFromPoint(x, y).slice(0, 4).map((item) => item.outerHTML.slice(0, 160)),
    };
  }, {
    x: markerBox.x + markerBox.width / 2,
    y: markerBox.y + markerBox.height / 2,
  });
  expect(hit.name, JSON.stringify(hit)).toBe(accessibleName);
}

test('setting takeoff from the map changes only takeoff and invalidates review', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await locate(page, { latitude: 37.8, longitude: -122.4 });

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);

  const originalTakeoff = [
    await page.getByRole('textbox', { name: 'Takeoff latitude' }).inputValue(),
    await page.getByRole('textbox', { name: 'Takeoff longitude' }).inputValue(),
  ];
  const originalRows = await rows(page).allTextContents();
  const calculated = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  const originalCalculation = await calculated.allInnerTexts();
  const canvas = await mapRegion(page).getByLabel('Map canvas').boundingBox();
  if (!canvas) throw new Error('Map canvas must be visible');

  await page.getByRole('button', { name: 'Set takeoff' }).click();
  await mapRegion(page).getByLabel('Map canvas').click({
    position: { x: canvas.width / 2 + 65, y: canvas.height / 2 + 35 },
  });

  const takeoffLatitude = page.getByRole('textbox', { name: 'Takeoff latitude' });
  const takeoffLongitude = page.getByRole('textbox', { name: 'Takeoff longitude' });
  await expect(async () => {
    expect([await takeoffLatitude.inputValue(), await takeoffLongitude.inputValue()]).not.toEqual(originalTakeoff);
  }).toPass({ timeout: 5000 });
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/unsaved/i);
  await expect(rows(page)).toHaveCount(2);
  await expect(await rows(page).allTextContents()).toEqual(originalRows);
  await expect(await calculated.allInnerTexts()).toEqual(originalCalculation);
  await expect(mapRegion(page).getByRole('button', { name: 'Takeoff', exact: true })).toBeVisible();
});
