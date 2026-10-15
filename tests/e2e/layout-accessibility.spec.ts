import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, openBlankEditor, rows } from './editor-helpers.js';

for (const width of [1024, 320]) {
  test(`persistent list-first inspector fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openBlankEditor(page);
    await importDraft(page, draftFixture());
    await rows(page).nth(0).click();
    const settings = page.getByRole('region', { name: 'Route settings' });
    const list = page.getByRole('region', { name: 'Waypoints' });
    const selected = page.getByRole('region', { name: 'Selected waypoint' });
    for (const region of [settings, list, selected]) await expect(region).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const listBox = await list.boundingBox();
    const selectedBox = await selected.boundingBox();
    if (!listBox || !selectedBox) throw new Error('Inspector sections must have layout');
    expect(listBox.y).toBeLessThan(selectedBox.y);
    if (width === 1024) {
      const map = await page.getByRole('region', { name: 'Mission map' }).boundingBox();
      const inspector = await settings.boundingBox();
      if (!map || !inspector) throw new Error('Desktop map and inspector must have layout');
      expect(map.x + map.width).toBeLessThanOrEqual(inspector.x + 1);
      expect(map.width).toBeGreaterThan(inspector.width);
    }
  });
}

test('light and dark system themes keep source controls usable', async ({ page }) => {
  await openBlankEditor(page);
  const name = page.getByRole('textbox', { name: 'Route name' });
  const styles: string[] = [];
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await name.fill(`${colorScheme} route`);
    await expect(name).toHaveValue(`${colorScheme} route`);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    styles.push(await name.evaluate((input) => {
      const style = getComputedStyle(input);
      return `${style.color}|${style.backgroundColor}`;
    }));
  }
  expect(styles[0]).not.toBe(styles[1]);
});

test('keyboard users can select a row, edit coordinates and open/cancel Save', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await rows(page).nth(0).focus();
  await page.keyboard.press('Enter');
  const latitude = page.getByRole('textbox', { name: 'Selected latitude' });
  await latitude.focus();
  await latitude.fill('37.8');
  await page.getByRole('button', { name: 'Save', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await expect(latitude).toHaveValue('37.8');
});
