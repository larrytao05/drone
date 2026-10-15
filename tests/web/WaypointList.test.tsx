import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Dispatch } from 'react';
import { WaypointList } from '../../web/WaypointList.js';
import type { EditorAction, RoutePoint } from '../../web/editor.js';
import { firstId, makePoints, secondId } from './fixtures.js';

afterEach(cleanup);

const points: readonly RoutePoint[] = [
  { id: firstId, coordinate: { latitude: '37.7', longitude: '-122.4' } },
  { id: secondId, coordinate: { latitude: '37.7', longitude: '-122.4' } },
];

describe('controlled waypoint list', () => {
  it('shows an empty message when no points are available', () => {
    render(<WaypointList dispatch={vi.fn<Dispatch<EditorAction>>()} points={[]} selectedPointId={null} />);

    expect(screen.getByText(/No waypoints yet/i)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps duplicate coordinates as separate, explicitly selected rows', () => {
    render(<WaypointList dispatch={vi.fn<Dispatch<EditorAction>>()} points={points} selectedPointId={secondId} />);

    const rows = within(screen.getByRole('list', { name: 'Waypoint order' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-current')).toBeNull();
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    expect(within(rows[0]!).getByRole('button', { name: 'Select waypoint 1' })).toBeTruthy();
    expect(within(rows[1]!).getByRole('button', { name: 'Select waypoint 2' })).toBeTruthy();
    for (const row of rows) expect(within(row).getAllByRole('button')).toHaveLength(3);
  });

  it('dispatches independent select and delete actions from sibling controls', () => {
    const dispatch = vi.fn<Dispatch<EditorAction>>();
    render(<WaypointList dispatch={dispatch} points={points} selectedPointId={null} />);
    const row = within(screen.getByRole('list', { name: 'Waypoint order' })).getAllByRole('listitem')[0];
    if (!row) throw new Error('First waypoint row should exist');

    fireEvent.click(within(row).getByRole('button', { name: 'Select waypoint 1' }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'select-point', id: firstId });
    dispatch.mockClear();

    fireEvent.click(within(row).getByRole('button', { name: 'Delete waypoint 1' }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'delete-point', id: firstId });
  });

  it('selects a focused row with Enter and leaves the reducer as the sole source writer', () => {
    const dispatch = vi.fn<Dispatch<EditorAction>>();
    render(<WaypointList dispatch={dispatch} points={points} selectedPointId={null} />);
    const row = screen.getAllByRole('listitem')[0];
    if (!row) throw new Error('First waypoint row should exist');

    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'select-point', id: firstId });
    expect(within(screen.getByRole('list', { name: 'Waypoint order' })).getAllByRole('listitem')[0]).toBe(row);
  });

  it('keeps all row controls available in a 100-point list', () => {
    const longList = makePoints(100);
    const selected = longList[99];
    if (!selected) throw new Error('One hundred points should include a final point');
    render(<WaypointList dispatch={vi.fn<Dispatch<EditorAction>>()} points={longList} selectedPointId={selected.id} />);

    const list = within(screen.getByRole('list', { name: 'Waypoint order' }));
    expect(list.getAllByRole('listitem')).toHaveLength(100);
    expect(screen.getByRole('button', { name: 'Select waypoint 100' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reorder waypoint 100' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete waypoint 100' })).toBeTruthy();
    expect(list.getAllByRole('listitem')[99]?.getAttribute('aria-current')).toBe('true');
  });
});
