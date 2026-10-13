import { expect, test, type Locator, type Page } from '@playwright/test';

async function openEditor(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue('');
}

function mapRegion(page: Page) {
  return page.getByRole('region', { name: 'Mission map' });
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

test('Add points appends one map click at the located map centre', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill('37.7749');
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill('-122.4194');
  await page.getByRole('button', { name: 'Locate' }).click();

  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Add points' }).click();
  await clickMapAt(map, 0.5, 0.5);

  const waypoints = page.getByRole('region', { name: 'Waypoints' });
  await expect(waypoints.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add points' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await waypoints.getByRole('listitem').first().click();

  const latitudeField = page.getByRole('textbox', { name: 'Selected latitude' });
  const longitudeField = page.getByRole('textbox', { name: 'Selected longitude' });
  const latitude = Number(await latitudeField.inputValue());
  const longitude = Number(await longitudeField.inputValue());
  expect(latitude).toBeCloseTo(37.7749, 4);
  expect(longitude).toBeCloseTo(-122.4194, 4);
});

test('Add points preserves the order of clicks across distant located map centres', async ({ page }) => {
  await openEditor(page);
  const routeName = 'Route across three locations';
  await page.getByRole('textbox', { name: 'Route name' }).fill(routeName);
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('30');

  const locations = [
    { latitude: 37.7749, longitude: -122.4194 },
    { latitude: 51.5074, longitude: -0.1278 },
    { latitude: -33.8688, longitude: 151.2093 },
  ];
  const map = mapRegion(page);
  const waypoints = page.getByRole('region', { name: 'Waypoints' });
  const addPoints = page.getByRole('button', { name: 'Add points' });

  for (const [index, location] of locations.entries()) {
    await page.getByRole('textbox', { name: 'Locator latitude' }).fill(String(location.latitude));
    await page.getByRole('textbox', { name: 'Locator longitude' }).fill(String(location.longitude));
    await page.getByRole('button', { name: 'Locate' }).click();
    await expect(map).toHaveAttribute('aria-busy', 'false');

    if (index === 0) await addPoints.click();
    await clickMapAt(map, 0.5, 0.5);

    await expect(waypoints.getByRole('listitem')).toHaveCount(index + 1);
    await expect(addPoints).toHaveAttribute('aria-pressed', 'true');
  }

  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(routeName);
  await expect(page.getByRole('textbox', { name: 'Height above takeoff' })).toHaveValue('30');

  for (const [index, location] of locations.entries()) {
    await waypoints.getByRole('listitem').nth(index).click();
    const latitude = Number(
      await page.getByRole('textbox', { name: 'Selected latitude' }).inputValue(),
    );
    const longitude = Number(
      await page.getByRole('textbox', { name: 'Selected longitude' }).inputValue(),
    );
    expect(latitude).toBeCloseTo(location.latitude, 4);
    expect(longitude).toBeCloseTo(location.longitude, 4);
  }
});

test('Select-mode click on empty map does not append a waypoint', async ({ page }) => {
  await openEditor(page);
  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  await clickMapAt(map, 0.2, 0.25);

  await expect(page.getByRole('region', { name: 'Waypoints' }).getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
});

test('clicking and dragging an existing map marker does not append another waypoint', async ({ page }) => {
  await openEditor(page);
  const map = mapRegion(page);
  await page.getByRole('textbox', { name: 'Locator latitude' }).fill('37.7749');
  await page.getByRole('textbox', { name: 'Locator longitude' }).fill('-122.4194');
  await page.getByRole('button', { name: 'Locate' }).click();
  await expect(map).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Add points' }).click();
  await clickMapAt(map, 0.5, 0.5);

  const waypoints = page.getByRole('region', { name: 'Waypoints' });
  await expect(waypoints.getByRole('listitem')).toHaveCount(1);
  const marker = map.getByRole('button', { name: 'Waypoint 1' });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(waypoints.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add points' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const bounds = await marker.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 16, {
    steps: 4,
  });
  await page.mouse.up();

  await expect(waypoints.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add points' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
