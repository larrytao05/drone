import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

test('takeoff is optional for calculation and mandatory for reviewed status', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture({ takeoff: null }));
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'Mark as reviewed' })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await locate(page, { latitude: 51.5074, longitude: -0.1278 });
  await page.getByRole('button', { name: 'Set takeoff' }).click();
  await mapRegion(page).locator('canvas').first().click();
  await expect(mapRegion(page).getByRole('button', { name: 'Takeoff', exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'Mark as reviewed' })).toBeEnabled();
});
