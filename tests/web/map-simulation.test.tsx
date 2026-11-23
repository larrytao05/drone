import { describe, expect, it } from 'vitest';
import type { Coordinate } from '@drone/mission-planner';
import type { MapGeometry } from '../../web/map-geometry.js';
import type { SimulationState } from '../../web/simulation.js';
import { createSimulationState, simulationReducer } from '../../web/simulation.js';
import type {
  LineFeatureCollection,
  MapSimulationView,
  SimulationMarker,
  SimulationResources,
} from '../../web/map-simulation.js';
import { createMapSimulation } from '../../web/map-simulation.js';

function makeGeometry(coords: readonly Coordinate[]): MapGeometry {
  return {
    points: coords.map((coordinate, index) => ({ id: `pt-${index + 1}`, coordinate })),
    lines: coords.length >= 2 ? [coords] : [],
    headings: coords.map((coordinate, index) => ({ coordinate, headingDeg: 90, waypointOrdinal: index + 1 })),
    omittedPointIds: [],
    takeoff: null,
    target: null,
  };
}

function simulationHarness() {
  const events: string[] = [];
  let droneMarker: { element: HTMLDivElement; coordinate: [number, number]; removed: boolean } | null = null;
  let blockedMarker: { element: HTMLDivElement; coordinate: [number, number]; removed: boolean } | null = null;
  let blockedLineData: LineFeatureCollection | null = null;
  let blockedLayerAdded = false;
  let blockedSourceAdded = false;

  const resources: SimulationResources = {
    createDroneMarker(element, coordinate) {
      events.push('create-drone-marker');
      const marker = {
        element,
        coordinate,
        removed: false,
        setLngLat(coord: [number, number]) {
          marker.coordinate = coord;
          return marker;
        },
        remove() {
          marker.removed = true;
          events.push('remove-drone-marker');
        },
      };
      droneMarker = marker;
      return marker as SimulationMarker;
    },
    createBlockedMarker(element, coordinate) {
      events.push('create-blocked-marker');
      const marker = {
        element,
        coordinate,
        removed: false,
        setLngLat(coord: [number, number]) {
          marker.coordinate = coord;
          return marker;
        },
        remove() {
          marker.removed = true;
          events.push('remove-blocked-marker');
        },
      };
      blockedMarker = marker;
      return marker as SimulationMarker;
    },
    addBlockedSource(data) {
      events.push('add-blocked-source');
      blockedSourceAdded = true;
      blockedLineData = data;
    },
    setBlockedData(data) {
      events.push('set-blocked-data');
      blockedLineData = data;
    },
    addBlockedLayer() {
      events.push('add-blocked-layer');
      blockedLayerAdded = true;
    },
    removeBlockedLayer() {
      events.push('remove-blocked-layer');
      blockedLayerAdded = false;
    },
    removeBlockedSource() {
      events.push('remove-blocked-source');
      blockedSourceAdded = false;
      blockedLineData = null;
    },
  };

  return {
    events,
    resources,
    getDroneMarker: () => droneMarker,
    getBlockedMarker: () => blockedMarker,
    getBlockedLineData: () => blockedLineData,
    isBlockedLayerAdded: () => blockedLayerAdded,
    isBlockedSourceAdded: () => blockedSourceAdded,
  };
}

function runState(sim: SimulationState, geom: MapGeometry): MapSimulationView {
  return { simulation: sim, geometry: geom };
}

describe('map simulation adapter lifecycle', () => {
  const threePoints: readonly Coordinate[] = [
    { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
    { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
    { latitudeDeg: 37.7769, longitudeDeg: -122.4174 },
  ];

  it('creates and positions native drone marker on simulation start and loaded', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    const sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'Test', waypointCount: 3, plannedAltitudeM: 25 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));

    // Before load: no markers created
    expect(harness.getDroneMarker()).toBeNull();

    adapter.loaded();

    // After load: drone marker created
    const drone = harness.getDroneMarker();
    expect(drone).not.toBeNull();
    expect(drone?.removed).toBe(false);
    expect(drone?.coordinate[0]).toBeCloseTo(-122.4194 + 0.001 * 0.24, 4);
    expect(drone?.coordinate[1]).toBeCloseTo(37.7749 + 0.001 * 0.24, 4);
    expect(drone?.element.getAttribute('aria-label')).toBe('Simulated drone position');
  });

  it('updates drone marker coordinate along route geometry as progress advances', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'Test', waypointCount: 3, plannedAltitudeM: 25 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    const initialLng = harness.getDroneMarker()!.coordinate[0];

    // Hold advances progress to 0.80
    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));
    const holdLng = harness.getDroneMarker()!.coordinate[0];
    expect(holdLng).toBeGreaterThan(initialLng);

    // Clear and resume advances progress to 1.20
    sim = simulationReducer(sim, { type: 'clear' });
    sim = simulationReducer(sim, { type: 'resume' });
    adapter.sync(runState(sim, geom));
    const resumeLng = harness.getDroneMarker()!.coordinate[0];
    expect(resumeLng).toBeGreaterThan(holdLng);
  });

  it('interpolates drone across antimeridian without wrapping around the globe', () => {
    const harness = simulationHarness();
    const crossingCoords: readonly Coordinate[] = [
      { latitudeDeg: 10, longitudeDeg: 179 },
      { latitudeDeg: 10, longitudeDeg: -179 },
    ];
    const geom = makeGeometry(crossingCoords);
    const sim: SimulationState = {
      ...createSimulationState(),
      phase: 'running',
      progress: 0.5,
      fresh: true,
      tick: 5,
      snapshot: { name: 'Crossing', waypointCount: 2, plannedAltitudeM: 30 },
    };

    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    const drone = harness.getDroneMarker();
    expect(drone).not.toBeNull();
    expect(drone?.coordinate[1]).toBeCloseTo(10, 4);
    // Should be at antimeridian (180 or -180), NOT near 0
    expect(Math.abs(drone!.coordinate[0])).toBe(180);
  });

  it('manages blocked segment GeoJSON lifecycle and note label with 2-point fixture', () => {
    const harness = simulationHarness();
    const twoPoints: readonly Coordinate[] = [
      { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
      { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
    ];
    const geom = makeGeometry(twoPoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'TwoPoints', waypointCount: 2, plannedAltitudeM: 20 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    // Block next segment
    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));

    // Blocked line layer and source added
    expect(harness.isBlockedSourceAdded()).toBe(true);
    expect(harness.isBlockedLayerAdded()).toBe(true);
    const lineData = harness.getBlockedLineData();
    expect(lineData?.features).toHaveLength(1);
    expect(lineData?.features[0]!.geometry.coordinates).toEqual([
      [-122.4194, 37.7749],
      [-122.4184, 37.7759],
    ]);

    // Blocked label marker has 2-point label (WP 1 to WP 2, not WP 2 to WP 3)
    const blockedLabel = harness.getBlockedMarker();
    expect(blockedLabel).not.toBeNull();
    expect(blockedLabel?.element.textContent).toBe('Blocked segment · WP 1 to WP 2');

    // Clear blockage: layer, source, and marker removed
    sim = simulationReducer(sim, { type: 'clear' });
    adapter.sync(runState(sim, geom));

    expect(harness.isBlockedLayerAdded()).toBe(false);
    expect(harness.isBlockedSourceAdded()).toBe(false);
    expect(harness.getBlockedMarker()?.removed).toBe(true);
  });

  it('manages blocked segment with 3-point fixture (WP 2 to WP 3)', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'ThreePoints', waypointCount: 3, plannedAltitudeM: 20 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));

    const blockedLabel = harness.getBlockedMarker();
    expect(blockedLabel?.element.textContent).toBe('Blocked segment · WP 2 to WP 3');
  });

  it('splits blocked segment across antimeridian into 2 LineStrings', () => {
    const harness = simulationHarness();
    const crossingCoords: readonly Coordinate[] = [
      { latitudeDeg: 12, longitudeDeg: 179 },
      { latitudeDeg: 12, longitudeDeg: -179 },
    ];
    const geom = makeGeometry(crossingCoords);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'CrossingBlock', waypointCount: 2, plannedAltitudeM: 20 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));

    const lineData = harness.getBlockedLineData();
    expect(lineData?.features).toHaveLength(2);
    expect(lineData?.features[0]!.geometry.coordinates).toEqual([[179, 12], [180, 12]]);
    expect(lineData?.features[1]!.geometry.coordinates).toEqual([[-180, 12], [-179, 12]]);
  });

  it('keeps last reported geographic position stable when telemetry drops', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'Test', waypointCount: 3, plannedAltitudeM: 25 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));

    const drone = harness.getDroneMarker()!;
    const lastLng = drone.coordinate[0];
    const lastLat = drone.coordinate[1];

    // Drop telemetry
    sim = simulationReducer(sim, { type: 'toggle-telemetry' });
    adapter.sync(runState(sim, geom));

    // Marker element updated to stale appearance and label
    expect(drone.element.getAttribute('aria-label')).toBe('Last known position');
    expect(drone.element.className).toContain('simDroneMarkerStale');
    expect(drone.element.textContent).toContain('Last known position');

    // Geographic coordinate remains exactly the same
    expect(drone.coordinate[0]).toBe(lastLng);
    expect(drone.coordinate[1]).toBe(lastLat);

    // Another sync while stale still keeps the exact same geographic coordinate
    adapter.sync(runState({ ...sim, tick: sim.tick + 10 }, geom));
    expect(drone.coordinate[0]).toBe(lastLng);
    expect(drone.coordinate[1]).toBe(lastLat);

    // Restoring telemetry updates to fresh appearance
    sim = simulationReducer(sim, { type: 'toggle-telemetry' });
    adapter.sync(runState(sim, geom));
    expect(drone.element.getAttribute('aria-label')).toBe('Simulated drone position');
    expect(drone.element.className).not.toContain('simDroneMarkerStale');
  });

  it('preserves native MapLibre marker classes via classList updates during telemetry changes', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'Test', waypointCount: 3, plannedAltitudeM: 25 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    const drone = harness.getDroneMarker()!;
    // Simulate MapLibre adding its native marker class
    drone.element.classList.add('maplibregl-marker');

    // Drop telemetry triggers updateDroneElement
    sim = simulationReducer(sim, { type: 'toggle-telemetry' });
    adapter.sync(runState(sim, geom));

    // Native MapLibre class must be preserved
    expect(drone.element.classList.contains('maplibregl-marker')).toBe(true);
    expect(drone.element.className).toContain('simDroneMarkerStale');

    // Restore telemetry
    sim = simulationReducer(sim, { type: 'toggle-telemetry' });
    adapter.sync(runState(sim, geom));

    expect(drone.element.classList.contains('maplibregl-marker')).toBe(true);
    expect(drone.element.className).not.toContain('simDroneMarkerStale');
  });

  it('cleans up all simulation markers and layers on end or dispose', () => {
    const harness = simulationHarness();
    const geom = makeGeometry(threePoints);
    let sim = simulationReducer(createSimulationState(), {
      type: 'start', snapshot: { name: 'Test', waypointCount: 3, plannedAltitudeM: 25 },
    });
    const adapter = createMapSimulation(harness.resources, runState(sim, geom));
    adapter.loaded();

    sim = simulationReducer(sim, { type: 'block' });
    adapter.sync(runState(sim, geom));

    expect(harness.getDroneMarker()?.removed).toBe(false);
    expect(harness.getBlockedMarker()?.removed).toBe(false);
    expect(harness.isBlockedLayerAdded()).toBe(true);

    // End simulation
    sim = simulationReducer(sim, { type: 'end' });
    adapter.sync(runState(sim, geom));

    expect(harness.getDroneMarker()?.removed).toBe(true);
    expect(harness.getBlockedMarker()?.removed).toBe(true);
    expect(harness.isBlockedLayerAdded()).toBe(false);
    expect(harness.isBlockedSourceAdded()).toBe(false);

    // Dispose
    adapter.dispose();
  });
});
