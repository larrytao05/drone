import { expect, test, type Page } from '@playwright/test';
import { coordinateFields, draftFixture, importDraft, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

async function prepare(page: Page) {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await rows(page).nth(0).click();
}

async function assertSwapped(page: Page) {
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await rows(page).nth(0).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
  await rows(page).nth(1).click();
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
  await handle.dragTo(mapRegion(page));
  await rows(page).nth(0).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await rows(page).nth(1).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
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
  await rows(page).nth(1).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37');
});
