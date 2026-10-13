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
