import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MissionEditor } from '../../web/MissionEditor.js';
import { MissionMap } from '../../web/MissionMap.js';
import { createdMaps, failMapConstruction, resetMaplibreDouble, workerUrl } from './maplibre-double.js';

const emptyPointView = {
  points: [],
  sourcePointIds: [],
  selectedPointId: null,
  tool: 'select',
  revision: 0,
  takeoff: null,
  target: null,
} as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => resetMaplibreDouble());

describe('local MapLibre foundation', () => {
  it('starts a source-free north-up canvas and disables rotation at the SDK boundary', async () => {
    render(<MissionMap sourceView={emptyPointView} onSourceAction={vi.fn()} />);

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
    render(<MissionMap sourceView={emptyPointView} onSourceAction={vi.fn()} />);
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
    const { unmount } = render(<MissionMap sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    await screen.findByText('Map ready');
    const [map] = createdMaps();
    unmount();
    expect(map?.removeCount).toBe(1);
  });

  it('does not construct a map when unmounted before the SDK import resolves', async () => {
    const { unmount } = render(<MissionMap sourceView={emptyPointView} onSourceAction={vi.fn()} />);
    unmount();
    await waitFor(() => expect(createdMaps()).toHaveLength(0));
  });
});
