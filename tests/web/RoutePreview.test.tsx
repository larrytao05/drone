import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { RoutePreview } from '../../web/RoutePreview.js';
import { analyseDraft } from '../../web/mission-input.js';
import { buildMapGeometry } from '../../web/map-geometry.js';
import { makeDraft, firstId } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPreview(draft: ReturnType<typeof makeDraft>) {
  const analysis = analyseDraft(draft);
  const geometry = buildMapGeometry({
    sourcePoints: analysis.sourcePoints,
    route: analysis.route,
    takeoff: analysis.takeoff,
    target: analysis.target,
  });
  return { analysis, geometry, view: <RoutePreview analysis={analysis} draft={draft} geometry={geometry} /> };
}

describe('read-only route preview', () => {
  it('renders planner output and labels the result as nominal', () => {
    const draft = makeDraft();
    const { analysis, geometry, view } = renderPreview(draft);
    if (analysis.route.kind !== 'calculated') throw new Error('Fixture must calculate');
    render(view);

    const table = screen.getByRole('table', { name: 'Calculated waypoints' });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(analysis.route.waypoints.length);
    for (const [index, waypoint] of analysis.route.waypoints.entries()) {
      const row = bodyRows[index];
      if (!row) throw new Error('Each calculated waypoint must have a table row');
      expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
        String(index + 1).padStart(2, '0'),
        String(waypoint.coordinate.latitudeDeg),
        String(waypoint.coordinate.longitudeDeg),
        String(waypoint.heightAboveTakeoffM),
        String(waypoint.headingDeg),
        String(waypoint.gimbalPitchDeg),
      ]);
    }
    expect(screen.getByText(/calculated values from the current route settings/i)).toBeTruthy();
    expect(geometry.omittedPointIds).toEqual([]);
  });

  it('clears stale rows on invalid input and restores current output when valid again', () => {
    const validDraft = makeDraft();
    const valid = renderPreview(validDraft);
    const rendered = render(valid.view);
    expect(within(screen.getByRole('table', { name: 'Calculated waypoints' })).getAllByRole('row')).toHaveLength(3);

    const invalidDraft = makeDraft({ points: validDraft.points.map((point) => point.id === firstId
      ? { ...point, coordinate: { ...point.coordinate, latitude: '-' } }
      : point) });
    const invalid = renderPreview(invalidDraft);
    rendered.rerender(invalid.view);
    expect(screen.queryByRole('table', { name: 'Calculated waypoints' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Route calculation issues' }).textContent).toContain('Waypoint 1:');

    rendered.rerender(valid.view);
    expect(within(screen.getByRole('table', { name: 'Calculated waypoints' })).getAllByRole('row')).toHaveLength(3);
  });

  it('keeps calculated polar values in the table and explains their map omission', () => {
    const draft = makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '90', longitude: '0' } },
      { id: '22222222-2222-4222-8222-222222222222', coordinate: { latitude: '80', longitude: '1' } },
    ] });
    const { view, geometry } = renderPreview(draft);
    const rendered = render(view);

    const table = screen.getByRole('table', { name: 'Calculated waypoints' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const polarRow = rows[1];
    if (!polarRow) throw new Error('The polar waypoint must remain in the calculated table');
    const latitudeCell = within(polarRow).getAllByRole('cell')[1];
    expect(latitudeCell?.textContent).toBe('90');
    expect(geometry.omittedPointIds).toEqual([firstId]);
    expect(screen.getByRole('note').textContent).toContain('is kept in the route table');

    const invalidDraft = { ...draft, height: '' };
    const invalid = renderPreview(invalidDraft);
    rendered.rerender(invalid.view);
    expect(screen.queryByRole('table', { name: 'Calculated waypoints' })).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('remains in the route source');
    expect(screen.getByRole('note').textContent).toContain('calculated values are unavailable');
    expect(screen.getByRole('note').textContent).not.toContain('route table');
    expect(invalidDraft.points[0]?.coordinate.latitude).toBe('90');
  });

  it('labels shared and target height issues distinctly without duplicate keys', () => {
    const draft = makeDraft({
      height: '',
      framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '' },
    });
    const { view } = renderPreview(draft);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(view);

    const issues = screen.getByRole('list', { name: 'Route calculation issues' });
    expect(within(issues).getByText(/Height above takeoff:/)).toBeTruthy();
    expect(within(issues).getByText(/Target height:/)).toBeTruthy();
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|duplicate key/i);
  });

  it('renders repeated global planner errors separately without duplicate keys', () => {
    const draft = makeDraft({
      framing: { kind: 'face-target', coordinate: { latitude: '0', longitude: '0' }, height: '10' },
    });
    const { analysis, view } = renderPreview(draft);
    if (analysis.route.kind !== 'not-calculated') throw new Error('The distant target must be rejected');
    expect(analysis.route.issues).toHaveLength(2);
    expect(analysis.route.issues[0]?.message).toBe(analysis.route.issues[1]?.message);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rendered = render(view);

    const issues = screen.getByRole('list', { name: 'Route calculation issues' });
    expect(within(issues).getAllByText(`Route: ${analysis.route.issues[0]?.message}`)).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|duplicate key/i);

    const correctedDraft = {
      ...draft,
      framing: { kind: 'face-target' as const, coordinate: { latitude: '37.776', longitude: '-122.419' }, height: '10' },
    };
    const corrected = renderPreview(correctedDraft);
    rendered.rerender(corrected.view);
    expect(screen.queryByRole('list', { name: 'Route calculation issues' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Calculated waypoints' })).toBeTruthy();
  });

  it('keeps a blank editor quiet until route input is entered', () => {
    const { view } = renderPreview(makeDraft({ points: [], height: '', framing: { kind: 'unselected' } }));
    render(view);

    expect(screen.getByText(/add at least two waypoints/i)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Route calculation issues' })).toBeNull();
  });
});
