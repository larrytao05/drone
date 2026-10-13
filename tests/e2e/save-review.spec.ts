import { expect, test } from '@playwright/test';
import { draftFixture, importDraft, openBlankEditor } from './editor-helpers.js';

test('saves an eligible review once and restores the saved reviewed source explicitly', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__testStorageWrites', { value: 0, writable: true });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      Reflect.set(window, '__testStorageWrites', Number(Reflect.get(window, '__testStorageWrites')) + 1);
      return original.call(this, key, value);
    };
  });
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const saveStatus = page.getByRole('status', { name: 'Save status' });
  await expect(saveStatus).toContainText(/unsaved|not saved/i);

  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  const reviewed = dialog.getByRole('checkbox', { name: 'Mark as reviewed' });
  await expect(reviewed).toBeEnabled();
  await reviewed.check();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: 'Confirm' }).dblclick();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => Reflect.get(window, '__testStorageWrites'))).toBe(1);
  await expect(saveStatus).toHaveText(/^saved$/i);
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Browser survey');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
});

test('a failed local write leaves the dialog open and does not acknowledge saved or reviewed state', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__rejectDraftWrites', false);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (Reflect.get(window, '__rejectDraftWrites')) throw new DOMException('storage full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await openBlankEditor(page);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Saved baseline');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(Object.keys(before).length).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Unsaved draft');
  await page.evaluate(() => Reflect.set(window, '__rejectDraftWrites', true));
  const saveStatus = page.getByRole('status', { name: 'Save status', includeHidden: true });
  await expect(saveStatus).toContainText(/unsaved|not saved/i);
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(saveStatus).toContainText(/unsaved|not saved/i);
  await expect(page.getByRole('status', { name: 'Review status' })).toContainText(/not reviewed|unreviewed/i);
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(before);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Unsaved draft');
  await page.getByRole('textbox', { name: 'Route name' }).fill('Saved baseline');
  await expect(saveStatus).toHaveText(/^saved$/i);
});

test('the review dialog contains keyboard focus and returns it to Save', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  const dialog = page.getByRole('dialog');
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();
});

test('a delayed import invalidates a captured Save snapshot before any write', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      return new Promise<string>((resolve, reject) => {
        Reflect.set(window, '__finishBackupRead', () => original.call(this).then(resolve, reject));
      });
    };
  });
  const incoming = draftFixture({ name: 'Arrived after Save opened' });
  await page.getByLabel('Import backup').setInputFiles({ name: 'delayed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, draft: incoming })) });
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, '__finishBackupRead'))).toBe('function');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  const before = await page.evaluate(() => Object.entries(localStorage));
  await page.evaluate(async () => {
    const finish = Reflect.get(window, '__finishBackupRead');
    if (typeof finish !== 'function') throw new Error('Backup read must be pending');
    await finish();
  });
  await expect(page.getByRole('textbox', { name: 'Route name', includeHidden: true })).toHaveValue(incoming.name);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(before);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Mark as reviewed' })).not.toBeChecked();
});

test('cancel and Escape preserve source and saved status', async ({ page }) => {
  await openBlankEditor(page);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Keep this source');
  const saveStatus = page.getByRole('status', { name: 'Save status' });
  const source = page.getByRole('textbox', { name: 'Route name' });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(source).toHaveValue('Keep this source');
  await expect(saveStatus).toContainText(/unsaved|not saved/i);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(source).toHaveValue('Keep this source');
  await expect(saveStatus).toContainText(/unsaved|not saved/i);
});
