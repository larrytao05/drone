import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { createMapSource, type MapSourceAction, type MapSourceView } from '../../web/map-source.js';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function point(id: string, latitudeDeg: number, longitudeDeg: number) {
  return { id, coordinate: { latitudeDeg, longitudeDeg } };
}

function view(
  points: MapSourceView['points'],
  sourcePointIds: readonly string[],
  overrides: Partial<MapSourceView> = {},
): MapSourceView {
  return {
    points,
    sourcePointIds,
    selectedPointId: null,
    tool: 'select',
    revision: 0,
    takeoff: null,
    target: null,
    ...overrides,
  };
}

function makeMap() {
  const container = document.createElement('div');
  document.body.append(container);
  const mapClicks = new Set<(event: { lngLat: { lat: number; lng: number }; target: EventTarget | null }) => void>();
  const markers = new Map<HTMLButtonElement, { coordinate: [number, number]; setLngLat(value: [number, number]): unknown; getElement(): HTMLButtonElement; remove(): void }>();
  const map = {
    getContainer: () => container,
    project: ([longitude, latitude]: [number, number]) => ({ x: longitude * 1000, y: latitude * 1000 }),
    unproject: ([x, y]: [number, number]) => ({ lat: y / 1000, lng: x / 1000 }),
    createMarker(element: HTMLButtonElement, coordinate: [number, number]) {
      const wrapper = document.createElement('div');
      wrapper.className = 'maplibregl-marker';
      wrapper.append(element);
      container.append(wrapper);
      const marker = {
        coordinate,
        setLngLat(value: [number, number]) {
          marker.coordinate = value;
          return marker;
        },
        getElement: () => element,
        remove() {
          wrapper.remove();
          markers.delete(element);
        },
      };
      markers.set(element, marker);
      return marker;
    },
    onClick(handler: (event: { lngLat: { lat: number; lng: number }; target: EventTarget | null }) => void) {
      mapClicks.add(handler);
      return () => mapClicks.delete(handler);
    },
  };
  return {
    map,
    markers,
    click(longitude: number, latitude: number, target: EventTarget | null = container) {
      for (const handler of mapClicks) handler({ lngLat: { lat: latitude, lng: longitude }, target });
    },
    listenerCount: () => mapClicks.size,
  };
}

function sendPointer(
  target: EventTarget,
  type: string,
  values: Readonly<{ pointerId: number; button?: number; clientX?: number; clientY?: number }>,
) {
  const event = new Event(type, { bubbles: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
}

describe('map point adapter', () => {
  it('keeps source ordinals when earlier points cannot be projected and retains marker identity after reorder', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const second = point(secondId, 12, 13);
    const adapter = createMapSource(harness.map, view([second], [firstId, secondId]), (action) => actions.push(action));
    const marker = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Waypoint 2"]');

    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe('02');
    adapter.sync(view([second], [secondId, firstId], { selectedPointId: secondId }));
    expect(harness.map.getContainer().querySelector('[aria-label="Waypoint 1"]')).toBe(marker);
    expect(marker?.getAttribute('aria-pressed')).toBe('true');
    expect(harness.markers.size).toBe(1);

    adapter.sync(view([], [secondId, firstId], { revision: 1 }));
    expect(harness.markers.size).toBe(0);
    adapter.dispose();
    expect(harness.listenerCount()).toBe(0);
    harness.map.getContainer().remove();
  });

  it('creates once only in Add points mode and serializes the map coordinate without changing the tool', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(firstId);
    const adapter = createMapSource(harness.map, view([], [], { tool: 'add-points' }), (action) => actions.push(action));

    harness.click(-122.4, 37.7);
    expect(actions).toEqual([{
      type: 'append-point',
      point: { id: firstId, coordinate: { latitude: '37.7', longitude: '-122.4' } },
    } satisfies MapSourceAction]);
    adapter.sync(view([point(firstId, 37.7, -122.4)], [firstId], { tool: 'select', revision: 1 }));
    harness.click(-122.3, 37.8);
    expect(actions).toHaveLength(1);
    adapter.dispose();
    harness.map.getContainer().remove();
  });

  it('keeps dragged coordinates transient until one release action and cancels after source replacement', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const initial = point(firstId, 37.7, -122.4);
    const adapter = createMapSource(harness.map, view([initial], [firstId]), (action) => actions.push(action));
    const marker = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Waypoint 1"]');
    if (marker === null) throw new Error('Expected a waypoint marker');

    sendPointer(marker, 'pointerdown', { pointerId: 7, button: 0, clientX: 200, clientY: 100 });
    sendPointer(window, 'pointermove', { pointerId: 7, clientX: 220, clientY: 120 });
    expect(harness.markers.get(marker)?.coordinate).toEqual([-122.38, 37.72]);
    expect(actions).toEqual([{ type: 'select-point', id: firstId }]);
    sendPointer(window, 'pointerup', { pointerId: 7 });
    expect(actions).toEqual([
      { type: 'select-point', id: firstId },
      { type: 'move-point', id: firstId, coordinate: { latitude: '37.72', longitude: '-122.38' } },
    ] satisfies MapSourceAction[]);

    adapter.sync(view([initial], [firstId]));
    sendPointer(marker, 'pointerdown', { pointerId: 8, button: 0, clientX: 200, clientY: 100 });
    sendPointer(window, 'pointermove', { pointerId: 8, clientX: 300, clientY: 200 });
    adapter.sync(view([point(firstId, 37.8, -122.5)], [firstId], { revision: 1 }));
    sendPointer(window, 'pointerup', { pointerId: 8 });
    expect(actions.filter((action) => action.type === 'move-point')).toHaveLength(1);
    expect(harness.markers.get(marker)?.coordinate).toEqual([-122.5, 37.8]);
    adapter.dispose();
    harness.map.getContainer().remove();
  });

  it('cancels Escape, pointercancel and stationary presses without committing source', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const adapter = createMapSource(harness.map, view([point(firstId, 1, 2)], [firstId]), (action) => actions.push(action));
    const marker = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Waypoint 1"]');
    if (marker === null) throw new Error('Expected a waypoint marker');

    sendPointer(marker, 'pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    sendPointer(window, 'pointermove', { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.keyDown(window, { key: 'Escape' });
    sendPointer(window, 'pointerup', { pointerId: 1 });
    sendPointer(marker, 'pointerdown', { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
    sendPointer(window, 'pointermove', { pointerId: 2, clientX: 30, clientY: 40 });
    sendPointer(window, 'pointercancel', { pointerId: 2 });
    sendPointer(window, 'pointerup', { pointerId: 2 });
    sendPointer(marker, 'pointerdown', { pointerId: 3, button: 0, clientX: 0, clientY: 0 });
    adapter.sync(view([point(firstId, 1, 2)], [firstId], { tool: 'add-points' }));
    sendPointer(window, 'pointerup', { pointerId: 3 });

    expect(actions.filter((action) => action.type === 'move-point')).toHaveLength(0);
    expect(harness.markers.get(marker)?.coordinate).toEqual([2, 1]);
    adapter.dispose();
    expect(harness.listenerCount()).toBe(0);
    harness.map.getContainer().remove();
  });

  it('does not append when a marker click bubbles through the map boundary', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const adapter = createMapSource(harness.map, view([point(firstId, 1, 2)], [firstId], { tool: 'add-points' }), (action) => actions.push(action));
    const marker = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Waypoint 1"]');
    if (marker === null) throw new Error('Expected a waypoint marker');
    fireEvent.click(marker);
    harness.click(2, 1, marker);
    expect(actions).toEqual([{ type: 'select-point', id: firstId }]);
    adapter.dispose();
    harness.map.getContainer().remove();
  });

  it('routes background clicks to the active reference tool with full precision and normalised longitude', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const source = view([], [], { tool: 'set-takeoff' });
    const adapter = createMapSource(harness.map, source, (action) => actions.push(action));

    harness.click(181.25, -12.345678912);
    expect(actions).toEqual([{
      type: 'set-takeoff',
      coordinate: { latitude: '-12.345678912', longitude: '-178.75' },
    }]);

    adapter.sync(view([], [], { tool: 'set-target', revision: 1 }));
    harness.click(-541.5, 22.123456789);
    expect(actions).toEqual([
      {
        type: 'set-takeoff',
        coordinate: { latitude: '-12.345678912', longitude: '-178.75' },
      },
      {
        type: 'set-target',
        coordinate: { latitude: '22.123456789', longitude: '178.5' },
      },
    ] satisfies MapSourceAction[]);
    adapter.dispose();
    harness.map.getContainer().remove();
  });

  it('updates, removes and isolates takeoff and target markers from point actions', () => {
    const harness = makeMap();
    const actions: MapSourceAction[] = [];
    const source = view([point(firstId, 37.7, -122.4)], [firstId], {
      tool: 'add-points',
      takeoff: { latitudeDeg: 37.6, longitudeDeg: -122.5 },
      target: { latitudeDeg: 37.8, longitudeDeg: -122.3 },
    });
    const adapter = createMapSource(harness.map, source, (action) => actions.push(action));
    const takeoff = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Takeoff"]');
    const target = harness.map.getContainer().querySelector<HTMLButtonElement>('[aria-label="Target"]');

    expect(takeoff).not.toBeNull();
    expect(target).not.toBeNull();
    expect(takeoff?.className).not.toBe(target?.className);
    expect(harness.markers.size).toBe(3);
    if (takeoff === null || target === null) throw new Error('Reference markers must be present');

    fireEvent.click(takeoff);
    fireEvent.click(target);
    harness.click(-122.5, 37.6, takeoff);
    harness.click(-122.3, 37.8, target);
    sendPointer(takeoff, 'pointerdown', { pointerId: 11, button: 0, clientX: 10, clientY: 20 });
    sendPointer(window, 'pointermove', { pointerId: 11, clientX: 50, clientY: 70 });
    sendPointer(window, 'pointerup', { pointerId: 11 });
    expect(actions).toEqual([]);

    adapter.sync(view([point(firstId, 37.7, -122.4)], [firstId], {
      tool: 'add-points',
      revision: 1,
      takeoff: { latitudeDeg: 37.61, longitudeDeg: -122.51 },
      target: null,
    }));
    expect(harness.map.getContainer().querySelector('[aria-label="Takeoff"]')).toBe(takeoff);
    expect(harness.markers.get(takeoff)?.coordinate).toEqual([-122.51, 37.61]);
    expect(harness.map.getContainer().querySelector('[aria-label="Target"]')).toBeNull();
    expect(harness.markers.size).toBe(2);

    adapter.sync(view([point(firstId, 37.7, -122.4)], [firstId], { revision: 2 }));
    expect(harness.map.getContainer().querySelector('[aria-label="Takeoff"]')).toBeNull();
    expect(harness.markers.size).toBe(1);
    adapter.dispose();
    expect(harness.markers.size).toBe(0);
    harness.map.getContainer().remove();
  });
});
