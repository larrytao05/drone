import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, openBlankEditor } from './editor-helpers.js';

async function slotSnapshot(page: import('@playwright/test').Page) {
  return page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)));
}

test('does not autoload or autosave, and explicit Load restores the slot as current work', async ({ page }) => {
  await openBlankEditor(page);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Stored source');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  const savedSlot = await slotSnapshot(page);
  expect(savedSlot).not.toEqual([]);

  await page.getByRole('textbox', { name: 'Route name' }).fill('Live unsaved source');
  expect(await slotSnapshot(page)).toEqual(savedSlot);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  await expect(page.getByRole('status', { name: 'Save status' })).toContainText(/unsaved|not saved/i);
  expect(await slotSnapshot(page)).toEqual(savedSlot);

  await page.getByRole('textbox', { name: 'Route name' }).fill('Preserve until explicit load');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Stored source');
  await expect(page.getByRole('status', { name: 'Save status' })).toContainText(/saved/i);
  await expect(page.getByRole('status', { name: 'Review status' })).toContainText(/not reviewed|unreviewed/i);
});

test('an inaccessible storage read preserves the current route', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__rejectDraftReads', false);
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (Reflect.get(window, '__rejectDraftReads')) throw new DOMException('storage blocked', 'SecurityError');
      return original.call(this, key);
    };
  });
  await openBlankEditor(page);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Stored source');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('textbox', { name: 'Route name' }).fill('Current work');
  const before = await slotSnapshot(page);
  await page.evaluate(() => Reflect.set(window, '__rejectDraftReads', true));
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /storage|load|access/i }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Current work');
  expect(await slotSnapshot(page)).toEqual(before);
  await expect(page.getByRole('status', { name: 'Save status' })).toContainText(/unsaved|not saved/i);
});

test('a corrupt saved slot cannot replace the current source', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('textbox', { name: 'Route name' }).fill('Current work');
  await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    if (keys.length !== 1 || !keys[0]) throw new Error('Fixture must have one saved slot');
    localStorage.setItem(keys[0], '{');
  });
  const before = await slotSnapshot(page);
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /load|invalid|corrupt|draft/i }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Current work');
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('30');
  expect(await slotSnapshot(page)).toEqual(before);
});

test('failed import keeps the previous full source and does not alter the saved slot', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  const before = await slotSnapshot(page);
  const fields = {
    name: await page.getByRole('textbox', { name: 'Route name' }).inputValue(),
    height: await page.getByRole('textbox', { name: 'Height above takeoff' }).inputValue(),
    rows: await page.getByRole('region', { name: 'Waypoints' }).getByRole('listitem').allTextContents(),
  };

  await page.getByLabel('Import backup').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"draft":{}}'),
  });

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(fields.name);
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue(fields.height);
  await expect(page.getByRole('region', { name: 'Waypoints' }).getByRole('listitem')).toHaveText(fields.rows);
  expect(await slotSnapshot(page)).toEqual(before);
});
