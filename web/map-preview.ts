import type { MapGeometry } from './map-geometry';

type LineFeatureCollection = Readonly<{
  type: 'FeatureCollection';
  features: readonly Readonly<{
    type: 'Feature';
    properties: Readonly<Record<string, never>>;
    geometry: Readonly<{ type: 'LineString'; coordinates: readonly (readonly [number, number])[] }>;
  }>[];
}>;

type PreviewHeading = MapGeometry['headings'][number];
type HeadingMarker = Readonly<{
  setLngLat(coordinate: [number, number]): HeadingMarker;
  setRotation(rotation: number): HeadingMarker;
  remove(): void;
}>;
type PreviewResources = Readonly<{
  addLineSource: (data: LineFeatureCollection) => void;
  setLineData: (data: LineFeatureCollection) => void;
  addLineLayer: () => void;
  removeLineLayer: () => void;
  removeLineSource: () => void;
  createHeadingMarker: (element: HTMLDivElement, coordinate: [number, number], rotation: number) => HeadingMarker;
}>;

function lineData(lines: MapGeometry['lines']): LineFeatureCollection {
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

function headingElement({ waypointOrdinal }: PreviewHeading): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'mission-heading-marker';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', `Camera heading for waypoint ${waypointOrdinal}`);
  element.style.pointerEvents = 'none';
  return element;
}

export function createMapPreview(resources: PreviewResources, initialGeometry: MapGeometry) {
  let geometry = initialGeometry;
  let loaded = false;
  let disposed = false;
  let lineSourceAdded = false;
  let lineLayerAdded = false;
  const headingMarkers = new globalThis.Map<number, HeadingMarker>();

  function syncHeadings(headings: readonly PreviewHeading[]) {
    const visibleOrdinals = new Set(headings.map(({ waypointOrdinal }) => waypointOrdinal));
    for (const [ordinal, marker] of headingMarkers) {
      if (visibleOrdinals.has(ordinal)) continue;
      marker.remove();
      headingMarkers.delete(ordinal);
    }
    for (const heading of headings) {
      const coordinate: [number, number] = [heading.coordinate.longitudeDeg, heading.coordinate.latitudeDeg];
      const marker = headingMarkers.get(heading.waypointOrdinal);
      if (marker === undefined) {
        headingMarkers.set(heading.waypointOrdinal, resources.createHeadingMarker(headingElement(heading), coordinate, heading.headingDeg));
      } else {
        marker.setLngLat(coordinate);
        marker.setRotation(heading.headingDeg);
      }
    }
  }

  function apply() {
    if (!loaded || disposed) return;
    const data = lineData(geometry.lines);
    if (!lineSourceAdded) {
      resources.addLineSource(data);
      lineSourceAdded = true;
    } else {
      resources.setLineData(data);
    }
    if (!lineLayerAdded) {
      resources.addLineLayer();
      lineLayerAdded = true;
    }
    syncHeadings(geometry.headings);
  }

  return {
    loaded() {
      if (disposed) return;
      loaded = true;
      apply();
    },
    sync(next: MapGeometry) {
      geometry = next;
      apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const marker of headingMarkers.values()) marker.remove();
      headingMarkers.clear();
      if (lineLayerAdded) resources.removeLineLayer();
      if (lineSourceAdded) resources.removeLineSource();
    },
  };
}
