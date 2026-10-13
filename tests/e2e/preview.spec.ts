import { expect, test } from '@playwright/test';
import { planMission } from '../../src/index.js';
import { coordinateFields, draftFixture, importDraft, mapRegion, openBlankEditor, rows } from './editor-helpers.js';

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

test('polar coordinates remain exact and editable even when their map marker is omitted', async ({ page }) => {
  const draft = draftFixture();
  await openBlankEditor(page);
  await importDraft(page, { ...draft, points: [{ ...draft.points[0], coordinate: { latitude: '90', longitude: '0' } }, { ...draft.points[1], coordinate: { latitude: '80', longitude: '1' } }] });
  await rows(page).nth(0).click();
  await expect(coordinateFields(page).latitude).toHaveValue('90');
  await expect(mapRegion(page).getByRole('button', { name: 'Waypoint 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Calculated waypoints' }).locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText(/projection|cannot.*map|outside.*map/i).first()).toBeVisible();
});
