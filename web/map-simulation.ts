import type { Coordinate } from '@drone/mission-planner';
import type { MapGeometry } from './map-geometry';
import { normaliseMapCoordinate, splitSegmentAtAntimeridian } from './map-geometry';
import type { SimulationState } from './simulation';
import { isActive, telemetryTimeDisplay } from './simulation';
import styles from './SimulationOverlay.module.css';

export type LineFeatureCollection = Readonly<{
  type: 'FeatureCollection';
  features: readonly Readonly<{
    type: 'Feature';
    properties: Readonly<Record<string, never>>;
    geometry: Readonly<{ type: 'LineString'; coordinates: readonly (readonly [number, number])[] }>;
  }>[];
}>;

export type SimulationMarker = Readonly<{
  setLngLat(coordinate: [number, number]): SimulationMarker;
  remove(): void;
}>;

export type SimulationResources = Readonly<{
  createDroneMarker: (element: HTMLDivElement, coordinate: [number, number]) => SimulationMarker;
  createBlockedMarker: (element: HTMLDivElement, coordinate: [number, number]) => SimulationMarker;
  addBlockedSource: (data: LineFeatureCollection) => void;
  setBlockedData: (data: LineFeatureCollection) => void;
  addBlockedLayer: () => void;
  removeBlockedLayer: () => void;
  removeBlockedSource: () => void;
}>;

export type MapSimulationView = Readonly<{
  simulation: SimulationState;
  geometry: MapGeometry;
}>;

export const DEFAULT_FIXTURE_COORDS: readonly Coordinate[] = [
  { latitudeDeg: 37.7749, longitudeDeg: -122.4194 },
  { latitudeDeg: 37.7759, longitudeDeg: -122.4184 },
  { latitudeDeg: 37.7769, longitudeDeg: -122.4174 },
];

export function getRouteCoordinates(geometry: MapGeometry): readonly Coordinate[] {
  if (geometry.headings.length >= 2) {
    return geometry.headings.map((h) => h.coordinate);
  }
  if (geometry.points.length >= 2) {
    return geometry.points.map((p) => p.coordinate);
  }
  const firstPoint = geometry.points[0];
  if (firstPoint !== undefined) {
    const p = firstPoint.coordinate;
    return [p, { latitudeDeg: p.latitudeDeg + 0.001, longitudeDeg: p.longitudeDeg + 0.001 }];
  }
  return DEFAULT_FIXTURE_COORDS;
}

export function getBlockedSegmentIndices(pointCount: number): { startIndex: number; endIndex: number } {
  const startIndex = pointCount === 2 ? 0 : 1;
  const endIndex = startIndex + 1;
  return { startIndex, endIndex };
}

export function getBlockedSegmentLabel(pointCount: number): string {
  const { startIndex, endIndex } = getBlockedSegmentIndices(pointCount);
  return `WP ${startIndex + 1} to WP ${endIndex + 1}`;
}

export function interpolateRouteCoordinate(
  coords: readonly Coordinate[],
  progress: number,
): Coordinate {
  const first = coords[0];
  if (first === undefined) {
    return { latitudeDeg: 37.7749, longitudeDeg: -122.4194 };
  }
  if (coords.length === 1) {
    return first;
  }
  const segmentCount = coords.length - 1;
  const segmentIndex = Math.min(Math.max(0, Math.floor(progress)), segmentCount - 1);
  const t = Math.min(1, Math.max(0, progress - segmentIndex));
  const pA = coords[segmentIndex] ?? first;
  const pB = coords[segmentIndex + 1] ?? pA;

  const lat = pA.latitudeDeg + (pB.latitudeDeg - pA.latitudeDeg) * t;

  let dLng = pB.longitudeDeg - pA.longitudeDeg;
  if (dLng > 180) {
    dLng -= 360;
  } else if (dLng < -180) {
    dLng += 360;
  }
  const rawLng = pA.longitudeDeg + dLng * t;
  return normaliseMapCoordinate({
    latitudeDeg: lat,
    longitudeDeg: rawLng,
  });
}

export function blockedLineData(start: Coordinate, end: Coordinate): LineFeatureCollection {
  const lines = splitSegmentAtAntimeridian(start, end);
  return {
    type: 'FeatureCollection',
    features: lines.map((line) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: line.map(({ longitudeDeg, latitudeDeg }) => [longitudeDeg, latitudeDeg]),
      },
    })),
  };
}

function createDroneElement(fresh: boolean, tick: number, coord: Coordinate, timestamp?: string | null): HTMLDivElement {
  const el = document.createElement('div');
  if (styles.simDroneMarker) el.classList.add(styles.simDroneMarker);
  if (!fresh && styles.simDroneMarkerStale) el.classList.add(styles.simDroneMarkerStale);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', fresh ? 'Simulated drone position' : 'Last known position');
  el.setAttribute('data-longitude', String(coord.longitudeDeg));
  el.setAttribute('data-latitude', String(coord.latitudeDeg));
  const dot = document.createElement('span');
  if (styles.simDroneDot) dot.className = styles.simDroneDot;
  const label = document.createElement('span');
  if (styles.simDroneLabel) label.className = styles.simDroneLabel;
  label.textContent = fresh ? 'Simulated drone' : `Last known position (${telemetryTimeDisplay(tick, timestamp)})`;
  el.append(dot, label);
  return el;
}

function updateDroneElement(el: HTMLDivElement, fresh: boolean, tick: number, coord: Coordinate, timestamp?: string | null) {
  if (styles.simDroneMarkerStale) {
    el.classList.toggle(styles.simDroneMarkerStale, !fresh);
  }
  el.setAttribute('aria-label', fresh ? 'Simulated drone position' : 'Last known position');
  el.setAttribute('data-longitude', String(coord.longitudeDeg));
  el.setAttribute('data-latitude', String(coord.latitudeDeg));
  const labelSelector = styles.simDroneLabel ? `.${styles.simDroneLabel}` : 'span:last-child';
  const label = el.querySelector<HTMLSpanElement>(labelSelector);
  if (label !== null) {
    label.textContent = fresh ? 'Simulated drone' : `Last known position (${telemetryTimeDisplay(tick, timestamp)})`;
  }
}

function createBlockedLabelElement(text: string): HTMLDivElement {
  const el = document.createElement('div');
  if (styles.simBlockedOverlay) el.classList.add(styles.simBlockedOverlay);
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', 'Blocked segment indicator');
  el.textContent = text;
  return el;
}

export function createMapSimulation(resources: SimulationResources, initialView: MapSimulationView | null) {
  let view = initialView;
  let loaded = false;
  let disposed = false;
  let droneMarker: SimulationMarker | null = null;
  let droneElement: HTMLDivElement | null = null;
  let blockedMarker: SimulationMarker | null = null;
  let blockedLabelElement: HTMLDivElement | null = null;
  let blockedSourceAdded = false;
  let blockedLayerAdded = false;
  let lastReportedCoordinate: Coordinate | null = null;
  let lastReportedTick = 0;
  let lastReportedTimestamp: string | null = null;

  function apply() {
    if (!loaded || disposed) return;
    if (view === null || !isActive(view.simulation)) {
      if (droneMarker !== null) {
        droneMarker.remove();
        droneMarker = null;
        droneElement = null;
      }
      if (blockedMarker !== null) {
        blockedMarker.remove();
        blockedMarker = null;
        blockedLabelElement = null;
      }
      if (blockedLayerAdded) {
        resources.removeBlockedLayer();
        blockedLayerAdded = false;
      }
      if (blockedSourceAdded) {
        resources.removeBlockedSource();
        blockedSourceAdded = false;
      }
      lastReportedCoordinate = null;
      lastReportedTimestamp = null;
      return;
    }

    const sim = view.simulation;
    const routeCoords = getRouteCoordinates(sim.snapshot?.geometry ?? view.geometry);

    // Telemetry & Drone position
    let currentCoord: Coordinate;
    const hasLiveTelemetry = sim.telemetry !== undefined && sim.telemetry !== null;

    if (hasLiveTelemetry) {
      if (sim.fresh) {
        currentCoord = {
          latitudeDeg: sim.telemetry!.lat,
          longitudeDeg: sim.telemetry!.lon,
        };
        lastReportedCoordinate = currentCoord;
        lastReportedTick = sim.tick;
        lastReportedTimestamp = sim.telemetry!.timestamp;
      } else {
        currentCoord = lastReportedCoordinate ?? {
          latitudeDeg: sim.telemetry!.lat,
          longitudeDeg: sim.telemetry!.lon,
        };
      }
    } else {
      if (sim.fresh) {
        currentCoord = interpolateRouteCoordinate(routeCoords, sim.progress);
        lastReportedCoordinate = currentCoord;
        lastReportedTick = sim.tick;
        lastReportedTimestamp = null;
      } else {
        currentCoord = lastReportedCoordinate ?? interpolateRouteCoordinate(routeCoords, sim.progress);
      }
    }
    const displayTick = sim.fresh ? sim.tick : lastReportedTick;
    const displayTimestamp = sim.fresh ? (sim.telemetry?.timestamp ?? null) : lastReportedTimestamp;

    if (droneMarker === null) {
      droneElement = createDroneElement(sim.fresh, displayTick, currentCoord, displayTimestamp);
      droneMarker = resources.createDroneMarker(droneElement, [currentCoord.longitudeDeg, currentCoord.latitudeDeg]);
    } else if (droneElement !== null) {
      updateDroneElement(droneElement, sim.fresh, displayTick, currentCoord, displayTimestamp);
      droneMarker.setLngLat([currentCoord.longitudeDeg, currentCoord.latitudeDeg]);
    }

    // Blocked segment
    if (sim.blocked) {
      const { startIndex, endIndex } = getBlockedSegmentIndices(routeCoords.length);
      const wpStart = routeCoords[startIndex] ?? DEFAULT_FIXTURE_COORDS[0]!;
      const wpEnd = routeCoords[endIndex] ?? DEFAULT_FIXTURE_COORDS[1]!;
      const labelText = `Blocked segment · WP ${startIndex + 1} to WP ${endIndex + 1}`;
      const midCoord = interpolateRouteCoordinate([wpStart, wpEnd], 0.5);

      const data = blockedLineData(wpStart, wpEnd);
      if (!blockedSourceAdded) {
        resources.addBlockedSource(data);
        blockedSourceAdded = true;
      } else {
        resources.setBlockedData(data);
      }
      if (!blockedLayerAdded) {
        resources.addBlockedLayer();
        blockedLayerAdded = true;
      }

      if (blockedMarker === null) {
        blockedLabelElement = createBlockedLabelElement(labelText);
        blockedMarker = resources.createBlockedMarker(blockedLabelElement, [midCoord.longitudeDeg, midCoord.latitudeDeg]);
      } else if (blockedLabelElement !== null) {
        blockedLabelElement.textContent = labelText;
        blockedMarker.setLngLat([midCoord.longitudeDeg, midCoord.latitudeDeg]);
      }
    } else {
      if (blockedLayerAdded) {
        resources.removeBlockedLayer();
        blockedLayerAdded = false;
      }
      if (blockedSourceAdded) {
        resources.removeBlockedSource();
        blockedSourceAdded = false;
      }
      if (blockedMarker !== null) {
        blockedMarker.remove();
        blockedMarker = null;
        blockedLabelElement = null;
      }
    }
  }

  return {
    loaded() {
      if (disposed) return;
      loaded = true;
      apply();
    },
    sync(next: MapSimulationView | null) {
      view = next;
      apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (droneMarker !== null) {
        droneMarker.remove();
        droneMarker = null;
        droneElement = null;
      }
      if (blockedMarker !== null) {
        blockedMarker.remove();
        blockedMarker = null;
        blockedLabelElement = null;
      }
      if (blockedLayerAdded) resources.removeBlockedLayer();
      if (blockedSourceAdded) resources.removeBlockedSource();
    },
  };
}
