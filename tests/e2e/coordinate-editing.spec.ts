import { expect, test, type Locator, type Page } from '@playwright/test';

const firstLocation = { latitude: 37.7749, longitude: -122.4194 };
const secondLocation = { latitude: 51.5074, longitude: -0.1278 };

async function openEditor(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
}

function mapRegion(page: Page) {
  return page.getByRole('region', { name: 'Mission map' });
}

function waypointsRegion(page: Page) {
  return page.getByRole('region', { name: 'Waypoints' });
}

async function clickMapAt(map: Locator, xFraction: number, yFraction: number) {
  const canvas = map.locator('canvas').first();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  await canvas.click({ position: { x: bounds.width * xFraction, y: bounds.height * yFraction } });
}

async function locate(page: Page, latitude: number, longitude: number) {
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill(String(latitude));
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill(String(longitude));
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(mapRegion(page)).toHaveAttribute('aria-busy', 'false');
}

async function addTwoPoints(page: Page) {
  await openEditor(page);
  const map = mapRegion(page);
  await page.getByRole('textbox', { name: 'Route name' }).fill('Coordinate edit route');
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('30');
  await page.getByRole('button', { name: 'Add points' }).click();

  for (const [index, location] of [firstLocation, secondLocation].entries()) {
    await locate(page, location.latitude, location.longitude);
    await clickMapAt(map, 0.5, 0.5);
    await expect(waypointsRegion(page).getByRole('listitem')).toHaveCount(index + 1);
  }

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const rows = waypointsRegion(page).getByRole('listitem');
  const fields = coordinateFields(page);
  for (const [index, location] of [firstLocation, secondLocation].entries()) {
    await rows.nth(index).click();
    await fields.latitude.fill(String(location.latitude));
    await fields.longitude.fill(String(location.longitude));
  }
  const settings = page.getByRole('region', { name: 'Route settings' });
  await settings.getByRole('combobox', { name: 'Framing' }).selectOption('fixed');
  await settings.getByRole('textbox', { name: 'Heading' }).fill('90');
  await settings.getByRole('textbox', { name: 'Gimbal pitch' }).fill('-45');
}

function coordinateFields(page: Page) {
  return {
    latitude: page.getByRole('textbox', { name: 'Selected latitude' }),
    longitude: page.getByRole('textbox', { name: 'Selected longitude' }),
  };
}

for (const field of ['latitude', 'longitude'] as const) {
  test(`edits only the selected ${field} and keeps the other point and route settings`, async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');
  const fields = coordinateFields(page);
  await rows.nth(0).click();
  const original = {
    latitude: await fields.latitude.inputValue(),
    longitude: await fields.longitude.inputValue(),
  };
  const replacement = field === 'latitude' ? '37.7750' : '-122.4000';
  await fields[field].fill(replacement);
  await expect(fields[field]).toHaveValue(replacement);
  const otherField = field === 'latitude' ? 'longitude' : 'latitude';
  await expect(fields[otherField]).toHaveValue(original[otherField]);
  const calculatedRows = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  await expect(calculatedRows).toHaveCount(2);
  await expect(async () => {
    const values = (await calculatedRows.nth(0).getByRole('cell').allTextContents())
      .map((text) => Number(text.trim()));
    expect(values).toContain(Number(replacement));
    expect(values).toContain(Number(original[otherField]));
  }).toPass({ timeout: 5000 });
  await rows.nth(1).click();
  await expect(fields.latitude).toHaveValue(String(secondLocation.latitude));
  await expect(fields.longitude).toHaveValue(String(secondLocation.longitude));
  await rows.nth(0).click();
  await expect(fields[field]).toHaveValue(replacement);
  await expect(fields[otherField]).toHaveValue(original[otherField]);

  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Coordinate edit route');
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('30');
  await expect(page.getByRole('combobox', { name: 'Framing' })).toHaveValue('fixed');
  await expect(page.getByRole('textbox', { name: 'Heading', exact: true })).toHaveValue('90');
  await expect(page.getByRole('textbox', { name: 'Gimbal pitch' })).toHaveValue('-45');
  });
}

test('keeps partial coordinate strings when selection moves away and back', async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');
  const fields = coordinateFields(page);

  for (const field of ['latitude', 'longitude'] as const) {
    for (const partial of ['', '-', '.', '1e']) {
      await rows.nth(0).click();
      await fields[field].fill(partial);
      await rows.nth(1).click();
      await expect(fields.latitude).toHaveValue(String(secondLocation.latitude));
      await expect(fields.longitude).toHaveValue(String(secondLocation.longitude));
      await rows.nth(0).click();
      await expect(fields[field]).toHaveValue(partial);
    }
  }
});

test('invalid coordinates remove the old marker and calculated rows while retaining the waypoint row', async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');
  await rows.nth(0).click();
  const latitude = coordinateFields(page).latitude;
  const card = page.getByRole('region', { name: 'Selected waypoint' });
  const map = mapRegion(page);

  await locate(page, firstLocation.latitude, firstLocation.longitude);
  await expect(map.getByRole('button', { name: 'Waypoint 1', exact: true })).toHaveCount(1);
  const calculatedRows = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  await expect(calculatedRows).toHaveCount(2);
  await latitude.fill('90.0001');
  await expect(latitude).toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByRole('alert')).not.toHaveText('');
  await expect(map.getByRole('button', { name: 'Waypoint 1', exact: true })).toHaveCount(0);
  await locate(page, secondLocation.latitude, secondLocation.longitude);
  await expect(map.getByRole('button', { name: 'Waypoint 2', exact: true })).toBeVisible();
  await expect(map.getByRole('button', { name: 'Waypoint 2', exact: true })).toHaveCount(1);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(0);

  await latitude.fill('37.7750');
  await expect(latitude).not.toHaveAttribute('aria-invalid', 'true');
  await locate(page, 37.775, firstLocation.longitude);
  await expect(map.getByRole('button', { name: 'Waypoint 1', exact: true })).toBeVisible();
  await expect(calculatedRows).toHaveCount(2);
  const firstCalculatedRow = calculatedRows.nth(0).getByRole('cell');
  await expect(async () => {
    const values = (await firstCalculatedRow.allTextContents()).map((text) => Number(text.trim()));
    expect(values).toContain(37.775);
    expect(values).toContain(-122.4194);
  }).toPass({ timeout: 5000 });
});
