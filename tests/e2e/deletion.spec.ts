import { expect, test } from '@playwright/test';
import { coordinateFields, draftFixture, importDraft, openBlankEditor, rows } from './editor-helpers.js';

test('deleting the selected row takes effect immediately and clears its coordinate card', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await rows(page).nth(0).click();
  await rows(page).nth(0).getByRole('button', { name: 'Delete waypoint 1' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(coordinateFields(page).latitude).toHaveCount(0);
  await rows(page).nth(0).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('30');
});

test('deleting an unselected row retains selection and deleting the final row leaves an editable empty list', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await rows(page).nth(0).click();
  await rows(page).nth(1).getByRole('button', { name: 'Delete waypoint 2' }).click();
  await expect(rows(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await rows(page).nth(0).getByRole('button', { name: 'Delete waypoint 1' }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add points' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});
