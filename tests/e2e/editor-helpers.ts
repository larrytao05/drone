import { expect, type Locator, type Page } from '@playwright/test';

const defaultDraft = {
    name: 'Browser survey',
    points: [
      { id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
      { id: '22222222-2222-4222-8222-222222222222', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
    ],
    height: '30',
    framing: { kind: 'fixed', heading: '90', pitch: '-45' },
    takeoff: { latitude: '37.7740', longitude: '-122.4200' },
};

export function draftFixture(): typeof defaultDraft;
export function draftFixture<T extends Record<string, unknown>>(overrides: T): Omit<typeof defaultDraft, keyof T> & T;
export function draftFixture(overrides: Record<string, unknown> = {}) {
  return structuredClone({ ...defaultDraft, ...overrides });
}

export async function openBlankEditor(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
}

export async function importDraft<T extends { name: string }>(page: Page, draft: T) {
  await page.getByLabel('Import backup').setInputFiles({
    name: 'route-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, draft })),
  });
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(
    draft.name,
  );
}

export async function addFixedRoute(page: Page) {
  const map = mapRegion(page);
  await page.getByRole('button', { name: 'Add points' }).click();
  const canvas = map.locator('canvas').first();
  for (const [index, location] of [
    { latitude: 37.7749, longitude: -122.4194 },
    { latitude: 51.5074, longitude: -0.1278 },
  ].entries()) {
    await locate(page, location);
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Mission map canvas is not visible');
    await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await expect(rows(page)).toHaveCount(index + 1);
  }
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const rowsList = rows(page);
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const [index, value] of ['37.7749', '37.7759'].entries()) {
    const row = rowsList.nth(index);
    await row.click();
    await page.getByRole('textbox', { name: 'Selected latitude' }).fill(value);
    await page.getByRole('textbox', { name: 'Selected longitude' }).fill(index ? '-122.4184' : '-122.4194');
  }
  const settings = page.getByRole('region', { name: 'Route settings' });
  await settings.getByRole('combobox', { name: 'Framing' }).selectOption('fixed');
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('30');
  await page.getByRole('textbox', { name: 'Heading' }).fill('90');
  await page.getByRole('textbox', { name: 'Gimbal pitch' }).fill('-45');
}

export function rows(page: Page): Locator {
  return page.getByRole('region', { name: 'Waypoints' }).getByRole('listitem');
}

export function mapRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Mission map' });
}

export function coordinateFields(page: Page) {
  return {
    latitude: page.getByRole('textbox', { name: 'Selected latitude' }),
    longitude: page.getByRole('textbox', { name: 'Selected longitude' }),
  };
}

export async function locate(page: Page, coordinate: { latitude: number; longitude: number }) {
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill(String(coordinate.latitude));
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill(String(coordinate.longitude));
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(mapRegion(page)).toHaveAttribute('aria-busy', 'false');
}
