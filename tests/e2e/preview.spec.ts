import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { planMission } from '../../src/index.js';
import { coordinateFields, draftFixture, importDraft, mapRegion, openBlankEditor, rows, selectWaypoint } from './editor-helpers.js';

test('the read-only calculated table agrees with the real face-target planner', async ({ page }) => {
  const draft = draftFixture({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' } });
  await openBlankEditor(page);
  await importDraft(page, draft);
  const expected = planMission({ shot: { kind: 'route', anchors: draft.points.map((point) => ({ latitudeDeg: Number(point.coordinate.latitude), longitudeDeg: Number(point.coordinate.longitude) })) }, heightAboveTakeoffM: 30, framing: { kind: 'face-target', target: { coordinate: { latitudeDeg: 37.776, longitudeDeg: -122.419 }, heightAboveTakeoffM: 10 } } });
  if (expected.kind !== 'calculated') throw new Error('Fixture must calculate');
  const table = page.getByRole('table', { name: 'Calculated waypoints' });
  const calculated = table.locator('tbody tr');
  await expect(calculated).toHaveCount(2);
  await expect(table.getByRole('textbox')).toHaveCount(0);
  const columns = await table.getByRole('columnheader').allTextContents();
  for (const [index, waypoint] of expected.waypoints.entries()) {
    for (const [pattern, value] of [[/latitude/i, waypoint.coordinate.latitudeDeg], [/longitude/i, waypoint.coordinate.longitudeDeg], [/height/i, waypoint.heightAboveTakeoffM], [/heading/i, waypoint.headingDeg], [/pitch/i, waypoint.gimbalPitchDeg]] satisfies readonly [RegExp, number][]) {
      const column = columns.findIndex((name) => pattern.test(name));
      expect(column).toBeGreaterThanOrEqual(0);
      await expect(async () => expect(Number(await calculated.nth(index).getByRole('cell').nth(column).innerText())).toBeCloseTo(value, 2)).toPass({ timeout: 5000 });
    }
  }
  await expect(page.getByText(/nominal/i).first()).toBeVisible();
});

test('invalid route clears and restores the current calculated table', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const table = page.getByRole('table', { name: 'Calculated waypoints' });
  const calculated = table.locator('tbody tr');
  await expect(calculated).toHaveCount(2);

  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('-');
  await expect(calculated).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);

  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('55');
  await expect(calculated).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(async () => {
      const values = (await calculated.nth(index).getByRole('cell').allTextContents()).map(Number);
      expect(values).toContain(55);
    }).toPass({ timeout: 5000 });
  }
});

test('calculated polar rows remain in the table while the map omission is explained', async ({ page }) => {
  const draft = draftFixture();
  await openBlankEditor(page);
  await importDraft(page, {
    ...draft,
    points: [
      { ...draft.points[0], coordinate: { latitude: '90', longitude: '0' } },
      { ...draft.points[1], coordinate: { latitude: '80', longitude: '1' } },
    ],
  });

  const table = page.getByRole('table', { name: 'Calculated waypoints' });
  const calculated = table.locator('tbody tr');
  await expect(calculated).toHaveCount(2);
  await expect(calculated.nth(0).getByRole('cell').nth(1)).toHaveText('90');
  await expect(calculated.nth(1).getByRole('cell').nth(1)).toHaveText('80');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('note')).toContainText(/polar waypoint is kept in the route table/i);
});

test('a 100-point calculated table stays inside a narrow viewport', async ({ page }) => {
  const draft = draftFixture();
  const points = Array.from({ length: 100 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    coordinate: { latitude: String(37 + index / 1000), longitude: '-122' },
  }));
  await openBlankEditor(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await importDraft(page, { ...draft, points });

  const table = page.getByRole('table', { name: 'Calculated waypoints' });
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(table.locator('tbody tr').nth(0).getByRole('cell').nth(1)).toHaveText('37');
  await expect(table.locator('tbody tr').nth(99).getByRole('cell').nth(1)).toHaveText('37.099');
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
});

test('incomplete input removes calculated rows and heading indicators, then recovers current values', async ({ page }) => {
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const calculated = page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr');
  const headings = mapRegion(page).getByRole('img', { name: /camera heading for waypoint/i });
  await expect(calculated).toHaveCount(2);
  await expect(headings).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('-');
  await expect(calculated).toHaveCount(0);
  await expect(headings).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Height above takeoff' }).fill('55');
  await expect(calculated).toHaveCount(2);
  for (const index of [0, 1]) await expect(async () => {
    const values = (await calculated.nth(index).getByRole('cell').allTextContents()).map(Number);
    expect(values).toContain(55);
  }).toPass({ timeout: 5000 });
});

test('native route line and heading markers render without covering source points', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  const map = mapRegion(page);
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('Map ready');

  const headings = map.locator('.mission-heading-marker');
  await expect(headings).toHaveCount(2);
  const firstHeading = headings.first();
  const firstHeadingHandle = await firstHeading.elementHandle();
  if (firstHeadingHandle === null) throw new Error('The first calculated heading must render');
  const headingTransform = () => firstHeading.evaluate((element) => element.style.transform);
  const initialTransform = await headingTransform();
  const headingBox = await firstHeading.boundingBox();
  const pointBox = await map.getByRole('button', { name: 'Waypoint 1', exact: true }).boundingBox();
  if (headingBox === null || pointBox === null) throw new Error('The calculated heading and source point must be visible');
  expect(headingBox.x + headingBox.width <= pointBox.x
    || pointBox.x + pointBox.width <= headingBox.x
    || headingBox.y + headingBox.height <= pointBox.y
    || pointBox.y + pointBox.height <= headingBox.y).toBe(true);

  await page.getByRole('textbox', { name: 'Heading', exact: true }).fill('180');
  await expect.poll(headingTransform).not.toBe(initialTransform);
  expect(await headings.first().evaluate((element, previous) => element === previous, firstHeadingHandle)).toBe(true);
  await expect(headings.first()).toHaveAttribute('aria-label', 'Camera heading for waypoint 1');

  await mkdir('/private/tmp/drone-stage2-s2-09-shots', { recursive: true });
  await page.screenshot({ path: '/private/tmp/drone-stage2-s2-09-shots/native-route.png', fullPage: true });
});

test('polar coordinates remain exact and editable even when their map marker is omitted', async ({ page }) => {
  const draft = draftFixture();
  await openBlankEditor(page);
  await importDraft(page, { ...draft, points: [{ ...draft.points[0], coordinate: { latitude: '90', longitude: '0' } }, { ...draft.points[1], coordinate: { latitude: '80', longitude: '1' } }] });
  await selectWaypoint(page, 1).click();
  await expect(coordinateFields(page).latitude).toHaveValue('90');
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText(/projection|cannot.*map|outside.*map/i).first()).toBeVisible();
});
