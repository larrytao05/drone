import { expect, test, type Page } from '@playwright/test';
import { coordinateFields, draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

async function prepare(page: Page) {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await rows(page).nth(0).click();
  await locate(page, { latitude: 37.7749, longitude: -122.4194 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/reviewed/i);
}

async function beginMove(page: Page) {
  const marker = mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true });
  const before = await marker.boundingBox();
  if (!before) throw new Error('Waypoint marker must be visible');
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 45, { steps: 8 });
  await expect(async () => {
    const moved = await marker.boundingBox();
    expect(moved?.x).not.toBe(before.x);
  }).toPass({ timeout: 5000 });
  const fields = coordinateFields(page);
  await expect(fields.latitude).toHaveValue('37.7749');
  await expect(fields.longitude).toHaveValue('-122.4194');
  return marker;
}

test('a completed map drag commits coordinates without appending or changing the other point', async ({ page }) => {
  await prepare(page);
  await beginMove(page);
  await page.mouse.up();
  await expect(async () => {
    const fields = coordinateFields(page);
    expect([await fields.latitude.inputValue(), await fields.longitude.inputValue()])
      .not.toEqual(['37.7749', '-122.4194']);
  }).toPass({ timeout: 5000 });
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);
  await rows(page).nth(1).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
  await expect(coordinateFields(page).longitude).toHaveValue('-122.4184');
});

for (const cancellation of ['Escape', 'pointercancel']) {
  test(`${cancellation} cancels a tentative move without changing reviewed source`, async ({ page }) => {
    await prepare(page);
    const marker = await beginMove(page);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else await marker.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();
    await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
    await expect(coordinateFields(page).longitude).toHaveValue('-122.4194');
    await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
    await expect(rows(page)).toHaveCount(2);
  });
}

test('a marker press and release without movement preserves review', async ({ page }) => {
  await prepare(page);
  await mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true }).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
});
