import { expect, test, type Page } from '@playwright/test';
import { coordinateFields, draftFixture, importDraft, mapRegion, openBlankEditor, rows, selectWaypoint } from './editor-helpers.js';
import { writeLocalDraft } from '../../web/draft-storage.js';
import type { MissionDraft } from '../../web/editor.js';

async function prepare(page: Page) {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await selectWaypoint(page, 1).click();
}

async function prepareReviewed(page: Page) {
  const draft: MissionDraft = {
    ...draftFixture(),
    framing: { kind: 'fixed', heading: '90', pitch: '-45' },
  };
  const savedSlots: Array<{ key: string; value: string }> = [];
  const write = writeLocalDraft({
    storage: {
      getItem: () => null,
      setItem(key, value) { savedSlots.push({ key, value }); },
    },
    draft,
    reviewed: true,
  });
  expect(write).toEqual({ kind: 'success' });
  const savedSlot = savedSlots[0];
  if (!savedSlot) throw new Error('The public storage writer should produce a local slot');
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), savedSlot);
  await openBlankEditor(page);
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/^saved$/i);
}

async function assertSwapped(page: Page) {
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(rows(page).nth(0).getByRole('button', { name: 'Select waypoint 1' })).toContainText('37.7759');
  await expect(rows(page).nth(1).getByRole('button', { name: 'Select waypoint 2' })).toContainText('37.7749');
  await rows(page).nth(0).getByRole('button', { name: 'Select waypoint 1' }).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
  await selectWaypoint(page, 2).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await expect(coordinateFields(page).longitude).toHaveValue('-122.4194');
}

test('pointer reordering preserves point identity, values and selected point', async ({ page }) => {
  await prepare(page);
  await rows(page).nth(0).getByRole('button', { name: 'Reorder waypoint 1' })
    .dragTo(rows(page).nth(1).getByRole('button', { name: 'Reorder waypoint 2' }));
  await assertSwapped(page);
});

test('keyboard reordering retains focus on the moved handle', async ({ page }) => {
  await prepare(page);
  await rows(page).nth(0).getByRole('button', { name: 'Reorder waypoint 1' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(rows(page).nth(1).getByRole('button', { name: 'Reorder waypoint 2' })).toBeFocused();
  await assertSwapped(page);
});

test('Escape and outside drops preserve the original ordering', async ({ page }) => {
  await prepare(page);
  const handle = rows(page).nth(0).getByRole('button', { name: 'Reorder waypoint 1' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await handle.dragTo(mapRegion(page));
  await selectWaypoint(page, 1).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await selectWaypoint(page, 2).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
});

test('a canceled pointer reorder preserves a reviewed source before and after drop', async ({ page }) => {
  await prepareReviewed(page);
  await selectWaypoint(page, 1).click();
  const handle = rows(page).nth(0).getByRole('button', { name: 'Reorder waypoint 1' });
  const destination = rows(page).nth(1).getByRole('button', { name: 'Reorder waypoint 2' });
  const sourceBounds = await handle.boundingBox();
  const destinationBounds = await destination.boundingBox();
  if (!sourceBounds || !destinationBounds) throw new Error('Sortable handles must be visible');

  await page.mouse.move(sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(destinationBounds.x + destinationBounds.width / 2, destinationBounds.y + destinationBounds.height / 2, { steps: 4 });
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/^saved$/i);

  await page.keyboard.press('Escape');
  await page.mouse.up();

  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(/^saved$/i);
  await expect(selectWaypoint(page, 1)).toContainText('37.7749');
});

test('a 100-point list remains keyboard-reorderable', async ({ page }) => {
  const draft = draftFixture();
  const points = Array.from({ length: 100 }, (_, index) => ({ id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, coordinate: { latitude: String(37 + index / 1000), longitude: '-122' } }));
  await openBlankEditor(page);
  await importDraft(page, { ...draft, points });
  await expect(rows(page)).toHaveCount(100);
  await rows(page).nth(0).getByRole('button', { name: 'Reorder waypoint 1' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(rows(page).nth(1).getByRole('button', { name: 'Select waypoint 2' })).toHaveText(/02\s*37\s*-122/);
  await selectWaypoint(page, 2).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37');
});
