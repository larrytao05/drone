import { expect, test, type Page } from '@playwright/test';

async function openEditor(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
}

async function saveNameOnlyDraft(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Route name' }).fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Mark as reviewed' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

test('opens a blank route', async ({ page }) => {
  await openEditor(page);

  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('');
  const waypoints = page.getByRole('region', { name: 'Waypoints' });
  await expect(waypoints).toBeVisible();
  await expect(waypoints.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Framing' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Selected latitude' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Selected longitude' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New' })).toBeVisible();

  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  const reviewedCheckbox = dialog.getByRole('checkbox', { name: 'Mark as reviewed' });
  await expect(dialog).toBeVisible();
  await expect(reviewedCheckbox).toBeDisabled();
  await expect(reviewedCheckbox).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('reload leaves the current draft blank until the saved slot is explicitly loaded', async ({ page }) => {
  await openEditor(page);
  await saveNameOnlyDraft(page, 'Saved survey');
  await page.reload();

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  await page.getByRole('button', { name: 'Load' }).click();

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Saved survey');
});

test('New keeps the saved slot available across reload until explicit Load', async ({ page }) => {
  await openEditor(page);
  await saveNameOnlyDraft(page, 'Saved survey');
  await page.getByRole('textbox', { name: 'Route name' }).fill('Unsaved route');
  await page.getByRole('button', { name: 'New' }).click();

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Framing' })).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
  await page.getByRole('button', { name: 'Load' }).click();

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Saved survey');
});
