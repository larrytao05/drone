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

  await canvas.click({
    position: { x: bounds.width * xFraction, y: bounds.height * yFraction },
  });
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
  await page.getByRole('textbox', { name: 'Route name' }).fill('Selection route');
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('30');
  await page.getByRole('button', { name: 'Add points' }).click();

  for (const [index, location] of [firstLocation, secondLocation].entries()) {
    await locate(page, location.latitude, location.longitude);
    await clickMapAt(map, 0.5, 0.5);
    await expect(waypointsRegion(page).getByRole('listitem')).toHaveCount(index + 1);
  }

  await page.getByRole('button', { name: 'Select', exact: true }).click();
}

async function assertSelectedCoordinate(
  page: Page,
  expected: { latitude: number; longitude: number },
) {
  const latitude = page.getByRole('textbox', { name: 'Selected latitude' });
  const longitude = page.getByRole('textbox', { name: 'Selected longitude' });
  await expect(async () => {
    await expect(latitude).toBeVisible();
    await expect(longitude).toBeVisible();
    const coordinate = {
      latitude: Number(await latitude.inputValue()),
      longitude: Number(await longitude.inputValue()),
    };
    expect(coordinate.latitude).toBeCloseTo(expected.latitude, 4);
    expect(coordinate.longitude).toBeCloseTo(expected.longitude, 4);
  }).toPass({ timeout: 5000 });
}

test('selecting a waypoint row updates the coordinate card and its map marker', async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');

  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');
  await assertSelectedCoordinate(page, firstLocation);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'true');
  const secondMarker = mapRegion(page).getByRole('button', { name: 'Waypoint 2' });
  await expect(secondMarker).toHaveAttribute('aria-pressed', 'true');
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 1' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await assertSelectedCoordinate(page, secondLocation);
});

test('select mode marker click selects its row and updates the coordinate card', async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'true');
  await locate(page, firstLocation.latitude, firstLocation.longitude);
  const map = mapRegion(page);
  const firstMarker = map.getByRole('button', { name: 'Waypoint 1', exact: true });
  await expect(firstMarker).toBeVisible();
  await firstMarker.click();

  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');
  await expect(firstMarker).toHaveAttribute('aria-pressed', 'true');
  await expect(map.getByRole('button', { name: 'Waypoint 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await assertSelectedCoordinate(page, firstLocation);
});

test('selection keeps route settings and list content visible while selection changes', async ({ page }) => {
  await addTwoPoints(page);
  const settings = page.getByRole('region', { name: 'Route settings' });
  const waypoints = waypointsRegion(page);

  await expect(settings).toBeVisible();
  await expect(settings.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('30');
  await expect(settings.getByRole('combobox', { name: 'Framing' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('Selection route');
  await expect(waypoints.getByRole('listitem')).toHaveCount(2);

  await waypoints.getByRole('listitem').nth(0).click();
  await assertSelectedCoordinate(page, firstLocation);
  await expect(page.getByRole('region', { name: 'Selected waypoint' })).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(waypoints.getByRole('listitem')).toHaveCount(2);
  await waypoints.getByRole('listitem').nth(1).click();

  await expect(settings).toBeVisible();
  await expect(waypoints.getByRole('listitem')).toHaveCount(2);
  const card = page.getByRole('region', { name: 'Selected waypoint' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('textbox')).toHaveCount(2);
  await expect(card.getByRole('textbox', { name: 'Selected latitude' })).toHaveCount(1);
  await expect(card.getByRole('textbox', { name: 'Selected longitude' })).toHaveCount(1);
  await assertSelectedCoordinate(page, secondLocation);
});

test('duplicate coordinates remain separately selectable through their row and marker IDs', async ({ page }) => {
  await addTwoPoints(page);
  const rows = waypointsRegion(page).getByRole('listitem');
  await rows.nth(0).click();
  await assertSelectedCoordinate(page, firstLocation);
  const latitudeField = page.getByRole('textbox', { name: 'Selected latitude' });
  const longitudeField = page.getByRole('textbox', { name: 'Selected longitude' });
  const rawLatitude = await latitudeField.inputValue();
  const rawLongitude = await longitudeField.inputValue();
  await rows.nth(1).click();
  await assertSelectedCoordinate(page, secondLocation);
  await latitudeField.fill(rawLatitude);
  await longitudeField.fill(rawLongitude);
  await expect(latitudeField).toHaveValue(rawLatitude);
  await expect(longitudeField).toHaveValue(rawLongitude);
  await rows.nth(0).click();
  await expect(latitudeField).toHaveValue(rawLatitude);
  await expect(longitudeField).toHaveValue(rawLongitude);
  await rows.nth(1).click();
  await expect(latitudeField).toHaveValue(rawLatitude);
  await expect(longitudeField).toHaveValue(rawLongitude);
  await expect(rows).toHaveCount(2);

  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 2' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'true');
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 1' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
