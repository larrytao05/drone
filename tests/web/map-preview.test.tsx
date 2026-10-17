import { describe, expect, it } from 'vitest';
import { analyseDraft } from '../../web/editor.js';
import { buildMapGeometry, type MapGeometry } from '../../web/map-geometry.js';
import { createMapPreview } from '../../web/map-preview.js';
import { makeDraft } from './fixtures.js';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';

function geometry(draft = makeDraft()): MapGeometry {
  const analysis = analyseDraft(draft);
  return buildMapGeometry({
    sourcePoints: analysis.sourcePoints,
    route: analysis.route,
    takeoff: analysis.takeoff,
    target: analysis.target,
  });
}

function harness() {
  const events: string[] = [];
  const markers: Array<{
    element: HTMLDivElement;
    coordinate: [number, number];
    rotation: number;
    setLngLat(coordinate: [number, number]): unknown;
    setRotation(rotation: number): unknown;
    remove(): void;
  }> = [];
  let lineData: unknown = null;
  const resources: Parameters<typeof createMapPreview>[0] = {
    addLineSource(data) {
      events.push('add-source');
      lineData = data;
    },
    setLineData(data) {
      events.push('set-data');
      lineData = data;
    },
    addLineLayer() {
      events.push('add-layer');
    },
    removeLineLayer() {
      events.push('remove-layer');
    },
    removeLineSource() {
      events.push('remove-source');
    },
    createHeadingMarker(element, coordinate, rotation) {
      const marker = {
        element,
        coordinate,
        rotation,
        setLngLat(next: [number, number]) {
          marker.coordinate = next;
          return marker;
        },
        setRotation(next: number) {
          marker.rotation = next;
          return marker;
        },
        remove() {
          events.push(`remove-heading-${element.getAttribute('aria-label')}`);
        },
      };
      markers.push(marker);
      events.push(`add-heading-${element.getAttribute('aria-label')}`);
      return marker;
    },
  };
  return {
    events,
    markers,
    resources,
    getLineData: () => lineData,
  };
}

describe('calculated native map preview adapter', () => {
  it('keeps the latest geometry before map load and emits exact antimeridian line data', () => {
    const initial = geometry();
    const latest = geometry(makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '0', longitude: '179' } },
      { id: secondId, coordinate: { latitude: '0', longitude: '-179' } },
    ] }));
    const map = harness();
    const adapter = createMapPreview(map.resources, initial);
    adapter.sync(latest);
    expect(map.events).toEqual([]);

    adapter.loaded();

    expect(map.events.slice(0, 2)).toEqual(['add-source', 'add-layer']);
    expect(map.getLineData()).toEqual({
      type: 'FeatureCollection',
      features: latest.lines.map((line) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: line.map(({ longitudeDeg, latitudeDeg }) => [longitudeDeg, latitudeDeg]) },
      })),
    });
  });

  it('updates position and clockwise rotation on the same heading marker', () => {
    const initial = geometry();
    const map = harness();
    const adapter = createMapPreview(map.resources, initial);
    adapter.loaded();
    const marker = map.markers[0];
    if (marker === undefined) throw new Error('Expected a calculated heading marker');
    const updated: MapGeometry = {
      ...initial,
      headings: initial.headings.map((heading, index) => index === 0
        ? { ...heading, coordinate: { latitudeDeg: 38, longitudeDeg: -121 }, headingDeg: 270 }
        : heading),
    };

    adapter.sync(updated);

    expect(map.markers).toHaveLength(2);
    expect(map.markers[0]).toBe(marker);
    expect(marker.coordinate).toEqual([-121, 38]);
    expect(marker.rotation).toBe(270);
    expect(marker.element.getAttribute('aria-label')).toBe('Camera heading for waypoint 1');
    expect(marker.element.style.pointerEvents).toBe('none');
    expect(marker.element.tagName).toBe('DIV');
  });

  it('preserves calculated waypoint numbering across polar omissions and clears stale overlays', () => {
    const polarGeometry = geometry(makeDraft({ points: [
      { id: firstId, coordinate: { latitude: '90', longitude: '0' } },
      { id: secondId, coordinate: { latitude: '80', longitude: '1' } },
    ] }));
    const map = harness();
    const adapter = createMapPreview(map.resources, polarGeometry);
    adapter.loaded();
    expect(map.markers.map(({ element }) => element.getAttribute('aria-label')))
      .toEqual(['Camera heading for waypoint 2']);

    adapter.sync({ ...polarGeometry, lines: [], headings: [] });

    expect(map.getLineData()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(map.events).toContain('remove-heading-Camera heading for waypoint 2');
    expect(map.markers).toHaveLength(1);
  });

  it('removes heading markers and native line resources once on disposal', () => {
    const map = harness();
    const adapter = createMapPreview(map.resources, geometry());
    adapter.loaded();
    adapter.dispose();
    adapter.dispose();

    expect(map.events.slice(-4)).toEqual([
      'remove-heading-Camera heading for waypoint 1',
      'remove-heading-Camera heading for waypoint 2',
      'remove-layer',
      'remove-source',
    ]);
  });
});
