import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MissionEditor } from '../../web/MissionEditor.js';
import { MissionMap } from '../../web/MissionMap.js';
import { analyseDraft } from '../../web/editor.js';
import { buildMapGeometry } from '../../web/map-geometry.js';
import { makeDraft } from './fixtures.js';
import { createdMaps, createdMarkers, deferMapLoad, failMapConstruction, resetMaplibreDouble, workerUrl } from './maplibre-double.js';

const emptyPointView = {
  points: [],
  sourcePointIds: [],
  selectedPointId: null,
  tool: 'select',
  revision: 0,
  takeoff: null,
  target: null,
} as const;
const emptyGeometry = {
  points: [], lines: [], headings: [], omittedPointIds: [], takeoff: null, target: null,
} as const;

function calculatedGeometry(longitude = '-122.4184') {
  const analysis = analyseDraft(makeDraft({ points: [
    { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
    { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude } },
  ] }));
  return buildMapGeometry({ sourcePoints: analysis.sourcePoints, route: analysis.route, takeoff: analysis.takeoff, target: analysis.target });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => resetMaplibreDouble());

describe('local MapLibre foundation', () => {
  it('renders only the latest calculated lines and headings after style load, then clears them', async () => {
    deferMapLoad();
    const first = calculatedGeometry();
    const latest = calculatedGeometry('-122.4174');
    const { rerender } = render(<MissionMap geometry={first} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    await waitFor(() => expect(createdMaps()).toHaveLength(1));
    rerender(<MissionMap geometry={latest} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    const [map] = createdMaps();
    act(() => map?.emit('load'));

    const source = map?.getSource('calculated-route');
    expect(source?.data).toEqual({
      type: 'FeatureCollection',
      features: latest.lines.map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line.map(({ longitudeDeg, latitudeDeg }) => [longitudeDeg, latitudeDeg]) },
      })),
    });
    const headings = document.querySelectorAll<HTMLElement>('.mission-heading-marker');
    expect([...headings].map((heading) => heading.getAttribute('aria-label'))).toEqual([
      'Camera heading for waypoint 1',
      'Camera heading for waypoint 2',
    ]);
    expect(createdMarkers().map(({ rotation, options }) => [rotation, options.rotationAlignment]))
      .toEqual([[90, 'map'], [90, 'map']]);
    expect(createdMarkers().map(({ options }) => options.offset)).toEqual([[0, -30], [0, -30]]);

    rerender(<MissionMap geometry={emptyGeometry} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    expect(map?.getSource('calculated-route')?.data).toEqual({ type: 'FeatureCollection', features: [] });
    expect(document.querySelectorAll('.mission-heading-marker')).toHaveLength(0);
  });

  it('starts a source-free north-up canvas and disables rotation at the SDK boundary', async () => {
    render(<MissionMap geometry={emptyGeometry} sourceView={emptyPointView} onSourceAction={vi.fn()} />);

    await screen.findByText('Map ready');
    const [map] = createdMaps();
    expect(map).toBeDefined();
    expect(map?.options.center).toEqual([-122.4194, 37.7749]);
    expect(map?.options.zoom).toBe(15);
    expect(map?.options).toMatchObject({
      bearing: 0,
      pitch: 0,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
    });
    expect(map?.disabledRotations).toEqual(['keyboard', 'touch']);
    expect(workerUrl()).toBe('/maplibre-gl-worker.mjs');
    expect(map?.options.style).toEqual({
      version: 8,
      name: 'Local background',
      projection: { type: 'mercator' },
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#d9e2df' } }],
    });
    expect(map?.controls).toHaveLength(1);
    expect(map?.controlPositions).toEqual(['bottom-right']);
    expect(map?.canvas.isConnected).toBe(true);
    expect(screen.getByText('Imagery is not connected.')).toBeTruthy();
  });

  it('keeps locator text editable on invalid input and changes only the local camera for valid input', async () => {
    render(<MissionMap geometry={emptyGeometry} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    await screen.findByText('Map ready');
    const latitude = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Locator latitude' });
    const longitude = screen.getByRole<HTMLInputElement>('textbox', { name: 'Locator longitude' });
    const form = screen.getByRole('form', { name: 'Map locator' });
    const status = screen.getByRole('status', { name: 'Map status' });

    fireEvent.change(latitude, { target: { value: '91' } });
    fireEvent.change(longitude, { target: { value: '0' } });
    fireEvent.submit(form);
    expect(latitude.getAttribute('aria-invalid')).toBe('true');
    expect(latitude.value).toBe('91');
    expect(within(form).getByRole('alert').textContent).toContain('Enter a value between -90 and 90.');
    expect(status.textContent).toContain('Center 37.7749, -122.4194');

    fireEvent.change(latitude, { target: { value: '51.5074' } });
    fireEvent.change(longitude, { target: { value: '-0.1278' } });
    fireEvent.submit(form);
    await waitFor(() => expect(status.textContent).toContain('Center 51.5074, -0.1278'));
    expect(latitude.value).toBe('51.5074');
    expect(longitude.value).toBe('-0.1278');
  });

  it('routes map clicks through the active takeoff and target source tools', async () => {
    const onSourceAction = vi.fn();
    const { rerender } = render(
      <MissionMap
        geometry={emptyGeometry}
        onSourceAction={onSourceAction}
        sourceView={{ ...emptyPointView, tool: 'set-takeoff' }}
      />,
    );
    await screen.findByText('Map ready');
    const [map] = createdMaps();

    act(() => map?.emitClick(181.25, -12.345678912));
    expect(onSourceAction).toHaveBeenLastCalledWith({
      type: 'set-takeoff',
      coordinate: { latitude: '-12.345678912', longitude: '-178.75' },
    });

    rerender(
      <MissionMap
        geometry={emptyGeometry}
        onSourceAction={onSourceAction}
        sourceView={{ ...emptyPointView, tool: 'set-target' }}
      />,
    );
    act(() => map?.emitClick(-122.123456789, 37.765432109));
    expect(onSourceAction).toHaveBeenLastCalledWith({
      type: 'set-target',
      coordinate: { latitude: '37.765432109', longitude: '-122.123456789' },
    });
  });

  it('keeps editing and Save available when native map construction fails', async () => {
    failMapConstruction();
    render(<MissionEditor />);

    await screen.findByText('Map rendering unavailable');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'Route settings' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Route preview' })).toBeTruthy();
    expect(screen.getByText('Imagery is not connected.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Mission map' }).textContent).toContain('Route editing and saving remain available.');
  });

  it('shows asynchronous rendering errors without removing the editor', async () => {
    render(<MissionEditor />);
    await screen.findByText('Map ready');
    const [map] = createdMaps();
    act(() => map?.emit('error'));
    expect(screen.getByRole('status', { name: 'Map status' }).textContent).toContain('Map rendering unavailable');
    expect(map?.removeCount).toBe(1);
    act(() => map?.emit('load'));
    expect(screen.getByRole('status', { name: 'Map status' }).textContent).toContain('Map rendering unavailable');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'Waypoints' })).toBeTruthy();
  });

  it('removes a constructed map exactly once on unmount', async () => {
    const { unmount } = render(<MissionMap geometry={emptyGeometry} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    await screen.findByText('Map ready');
    const [map] = createdMaps();
    unmount();
    expect(map?.removeCount).toBe(1);
  });

  it('disposes calculated layers and headings before removing the native map', async () => {
    const { unmount } = render(<MissionMap geometry={calculatedGeometry()} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    await screen.findByText('Map ready');
    const [map] = createdMaps();

    unmount();

    expect(map?.removeSnapshot).toEqual({ sources: [], layers: [], headings: 0 });
  });

  it('does not construct a map when unmounted before the SDK import resolves', async () => {
    const { unmount } = render(<MissionMap geometry={emptyGeometry} sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    unmount();
    await waitFor(() => expect(createdMaps()).toHaveLength(0));
  });
});
