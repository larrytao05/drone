import { expect, test, type Page } from '@playwright/test';
import { coordinateFields, draftFixture, importDraft, locate, mapRegion, openBlankEditor, rows, selectWaypoint } from './editor-helpers.js';

async function prepare(page: Page) {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await selectWaypoint(page, 1).click();
  await locate(page, { latitude: 37.7749, longitude: -122.4194 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/reviewed/i);
}

async function beginMove(page: Page) {
  const marker = mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true });
  const before = await marker.boundingBox();
  if (!before) throw new Error('Waypoint marker must be visible');
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 45, { steps: 8 });
  await expect(async () => {
    const moved = await marker.boundingBox();
    expect(moved?.x).not.toBe(before.x);
  }).toPass({ timeout: 5000 });
  const fields = coordinateFields(page);
  await expect(fields.latitude).toHaveValue('37.7749');
  await expect(fields.longitude).toHaveValue('-122.4194');
  return marker;
}

test('a completed map drag commits coordinates without appending or changing the other point', async ({ page }) => {
  await prepare(page);
  await beginMove(page);
  await page.mouse.up();
  await expect(async () => {
    const fields = coordinateFields(page);
    expect([await fields.latitude.inputValue(), await fields.longitude.inputValue()])
      .not.toEqual(['37.7749', '-122.4194']);
  }).toPass({ timeout: 5000 });
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);
  await selectWaypoint(page, 2).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
  await expect(coordinateFields(page).longitude).toHaveValue('-122.4184');
});

for (const cancellation of ['Escape', 'pointercancel']) {
  test(`${cancellation} cancels a tentative move without changing reviewed source`, async ({ page }) => {
    await prepare(page);
    const marker = await beginMove(page);
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else await marker.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();
    await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
    await expect(coordinateFields(page).longitude).toHaveValue('-122.4194');
    await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
    await expect(rows(page)).toHaveCount(2);
  });
}

test('a marker press and release without movement preserves review', async ({ page }) => {
  await prepare(page);
  await mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true }).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);
});

test('waypoint markers stay clear of map controls at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');

  const overlays = [
    await map.getByRole('form', { name: 'Map locator' }).boundingBox(),
    await map.getByRole('status', { name: 'Map status' }).boundingBox(),
    await map.getByText('Imagery is not connected.').boundingBox(),
  ];
  expect(overlays.every((overlay) => overlay !== null)).toBe(true);

  for (const ordinal of [1, 2]) {
    const marker = map.getByRole('button', { name: `Waypoint ${ordinal}`, exact: true });
    const markerBox = await marker.boundingBox();
    expect(markerBox).not.toBeNull();
    if (markerBox === null) continue;
    for (const overlay of overlays) {
      if (overlay === null) continue;
      const overlaps = markerBox.x < overlay.x + overlay.width
        && markerBox.x + markerBox.width > overlay.x
        && markerBox.y < overlay.y + overlay.height
        && markerBox.y + markerBox.height > overlay.y;
      expect(overlaps).toBe(false);
    }
  }

  await map.getByRole('button', { name: 'Waypoint 2', exact: true }).click();
  await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
});

test('an off-centre marker drag preserves its grab offset without panning the map', async ({ page }) => {
  await prepare(page);
  const map = mapRegion(page);
  const mapView = map.getByLabel('Map view');
  const viewBefore = await mapView.textContent();
  const marker = map.getByRole('button', { name: 'Waypoint 1', exact: true });
  const before = await marker.boundingBox();
  if (!before) throw new Error('Waypoint marker must be visible');

  const grabX = before.x + before.width / 4;
  const grabY = before.y + before.height / 2;
  expect(await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target?.getAttribute('aria-label') === 'Waypoint 1';
  }, { x: grabX, y: grabY })).toBe(true);
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 20, grabY + 10, { steps: 1 });
  await expect(async () => {
    const moved = await marker.boundingBox();
    expect(moved).not.toBeNull();
    if (!moved) return;
    expect(Math.abs(moved.x - (before.x + 20))).toBeLessThan(1.5);
    expect(Math.abs(moved.y - (before.y + 10))).toBeLessThan(1.5);
  }).toPass({ timeout: 5000 });
  await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
  await expect(coordinateFields(page).longitude).toHaveValue('-122.4194');
  await page.mouse.up();
  await expect(map).toHaveAttribute('aria-busy', 'false');
  await expect(mapView).toHaveText(viewBefore ?? '');
  await expect(async () => {
    const fields = coordinateFields(page);
    expect([await fields.latitude.inputValue(), await fields.longitude.inputValue()])
      .not.toEqual(['37.7749', '-122.4194']);
  }).toPass({ timeout: 5000 });
});

test('native touch marker drag preserves its offset and commits once on release', async ({ page }) => {
  await prepare(page);
  const map = mapRegion(page);
  const mapView = map.getByLabel('Map view');
  const viewBefore = await mapView.textContent();
  const marker = map.getByRole('button', { name: 'Waypoint 1', exact: true });
  const before = await marker.boundingBox();
  if (!before) throw new Error('Waypoint marker must be visible');

  const grabX = before.x + before.width / 4;
  const grabY = before.y + before.height / 2;
  expect(await page.evaluate(({ x, y }) => {
    return document.elementFromPoint(x, y)?.getAttribute('aria-label') === 'Waypoint 1';
  }, { x: grabX, y: grabY })).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 1, x: grabX, y: grabY, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: grabX + 20, y: grabY + 10, radiusX: 1, radiusY: 1, force: 1 }],
    });

    await expect(async () => {
      const moved = await marker.boundingBox();
      expect(moved).not.toBeNull();
      if (!moved) return;
      expect(Math.abs(moved.x - (before.x + 20))).toBeLessThan(1.5);
      expect(Math.abs(moved.y - (before.y + 10))).toBeLessThan(1.5);
    }).toPass({ timeout: 5000 });
    await expect(coordinateFields(page).latitude).toHaveValue('37.7749');
    await expect(coordinateFields(page).longitude).toHaveValue('-122.4194');
    await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/^reviewed$/i);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(map).toHaveAttribute('aria-busy', 'false');
    await expect(mapView).toHaveText(viewBefore ?? '');
    await expect(async () => {
      const fields = coordinateFields(page);
      expect([await fields.latitude.inputValue(), await fields.longitude.inputValue()])
        .not.toEqual(['37.7749', '-122.4194']);
    }).toPass({ timeout: 5000 });
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole('status', { name: 'Review status' })).toHaveText(/not reviewed|unreviewed/i);
    await selectWaypoint(page, 2).click();
    await expect(coordinateFields(page).latitude).toHaveValue('37.7759');
    await expect(coordinateFields(page).longitude).toHaveValue('-122.4184');
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
  }
});

test('a native touch on the canvas still pans the map', async ({ page }) => {
  await openBlankEditor(page);
  const map = mapRegion(page);
  await expect(map).toHaveAttribute('aria-busy', 'false');
  const mapView = map.getByLabel('Map view');
  const before = await mapView.textContent();
  const canvas = await map.getByLabel('Map canvas').boundingBox();
  if (!canvas) throw new Error('Map canvas must be visible');
  const x = canvas.x + canvas.width / 2;
  const y = canvas.y + canvas.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 1, x, y, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: x + 35, y: y + 20, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(map).toHaveAttribute('aria-busy', 'false');
    await expect(mapView).not.toHaveText(before ?? '');
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
  }
});
