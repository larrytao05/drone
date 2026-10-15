import type { Coordinate } from '@drone/mission-planner';
import type { CoordinateText, EditorAction, EditorState, RoutePoint } from './editor';
import { normaliseMapCoordinate } from './map-geometry';

type ProjectedPoint = Readonly<{ id: string; coordinate: Coordinate }>;

export type MapPointView = Readonly<{
  points: readonly ProjectedPoint[];
  sourcePointIds: readonly string[];
  selectedPointId: string | null;
  tool: EditorState['tool'];
  revision: number;
}>;

export type MapPointAction = Extract<EditorAction, { type: 'append-point' | 'select-point' | 'move-point' }>;

type PointMarker = Readonly<{
  setLngLat(coordinate: [number, number]): PointMarker;
  remove(): void;
}>;

type PointMap = Readonly<{
  project(coordinate: [number, number]): Readonly<{ x: number; y: number }>;
  unproject(point: [number, number]): Readonly<{ lat: number; lng: number }>;
  createMarker(element: HTMLButtonElement, coordinate: [number, number]): PointMarker;
  onClick(handler: (event: Readonly<{
    lngLat: Readonly<{ lat: number; lng: number }>;
    target: EventTarget | null;
  }>) => void): () => void;
}>;

type MarkerRecord = Readonly<{ marker: PointMarker; element: HTMLButtonElement }>;
type Drag = {
  id: string;
  marker: PointMarker;
  pointerId: number;
  revision: number;
  tool: EditorState['tool'];
  initialCoordinate: Coordinate;
  initialScreenPoint: Readonly<{ x: number; y: number }>;
  initialPointer: Readonly<{ x: number; y: number }>;
  coordinate: Coordinate;
};

function sourceCoordinate(point: ProjectedPoint): [number, number] {
  return [point.coordinate.longitudeDeg, point.coordinate.latitudeDeg];
}

function textCoordinate(coordinate: Coordinate): CoordinateText {
  return {
    latitude: String(coordinate.latitudeDeg),
    longitude: String(coordinate.longitudeDeg),
  };
}

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.latitudeDeg === right.latitudeDeg && left.longitudeDeg === right.longitudeDeg;
}

function isMapMarker(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.maplibregl-marker') !== null;
}

export function createMapPoints(
  map: PointMap,
  initialView: MapPointView,
  dispatch: (action: MapPointAction) => void,
) {
  const markers = new globalThis.Map<string, MarkerRecord>();
  let view = initialView;
  let drag: Drag | null = null;

  function sourceOrdinal(id: string): number | null {
    const index = view.sourcePointIds.indexOf(id);
    return index < 0 ? null : index + 1;
  }

  function syncMarkers() {
    const visibleIds = new Set(view.points.map((point) => point.id));
    for (const [id, record] of markers) {
      if (visibleIds.has(id)) continue;
      record.marker.remove();
      markers.delete(id);
    }

    for (const point of view.points) {
      const ordinal = sourceOrdinal(point.id);
      if (ordinal === null) continue;
      let record = markers.get(point.id);
      if (record === undefined) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'mission-point-marker';
        element.addEventListener('click', (event) => event.stopPropagation());
        element.addEventListener('mousedown', (event) => event.stopPropagation());
        element.addEventListener('touchstart', (event) => event.stopPropagation());
        element.addEventListener('pointerdown', (event) => beginDrag(point.id, event));
        element.addEventListener('click', () => dispatch({ type: 'select-point', id: point.id }));
        record = { marker: map.createMarker(element, sourceCoordinate(point)), element };
        markers.set(point.id, record);
      }
      record.element.setAttribute('aria-label', `Waypoint ${ordinal}`);
      record.element.setAttribute('aria-pressed', String(point.id === view.selectedPointId));
      record.element.textContent = String(ordinal).padStart(2, '0');
      if (drag?.id !== point.id) record.marker.setLngLat(sourceCoordinate(point));
    }
  }

  function clearDragListeners() {
    window.removeEventListener('pointermove', moveDrag);
    window.removeEventListener('pointerup', finishDrag);
    window.removeEventListener('pointercancel', cancelDrag);
  }

  function cancelDrag() {
    if (drag === null) return;
    drag = null;
    clearDragListeners();
    syncMarkers();
  }

  function beginDrag(id: string, event: PointerEvent) {
    event.stopPropagation();
    if (event.button !== 0) return;
    const record = markers.get(id);
    const point = view.points.find((candidate) => candidate.id === id);
    if (record === undefined || point === undefined) return;
    dispatch({ type: 'select-point', id });
    drag = {
      id,
      marker: record.marker,
      pointerId: event.pointerId,
      revision: view.revision,
      tool: view.tool,
      initialCoordinate: point.coordinate,
      initialScreenPoint: map.project(sourceCoordinate(point)),
      initialPointer: { x: event.clientX, y: event.clientY },
      coordinate: point.coordinate,
    };
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function moveDrag(event: PointerEvent) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.initialPointer.x;
    const deltaY = event.clientY - drag.initialPointer.y;
    const projected = deltaX === 0 && deltaY === 0
      ? null
      : map.unproject([
        drag.initialScreenPoint.x + deltaX,
        drag.initialScreenPoint.y + deltaY,
      ]);
    const coordinate = projected === null ? drag.initialCoordinate : normaliseMapCoordinate({
      latitudeDeg: projected.lat,
      longitudeDeg: projected.lng,
    });
    drag.coordinate = coordinate;
    drag.marker.setLngLat([coordinate.longitudeDeg, coordinate.latitudeDeg]);
  }

  function finishDrag(event: PointerEvent) {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const completed = drag;
    drag = null;
    clearDragListeners();
    if (!sameCoordinate(completed.initialCoordinate, completed.coordinate)
      && completed.revision === view.revision && completed.tool === view.tool
      && view.sourcePointIds.includes(completed.id)) {
      dispatch({ type: 'move-point', id: completed.id, coordinate: textCoordinate(completed.coordinate) });
      return;
    }
    syncMarkers();
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    cancelDrag();
  }

  function handleMapClick(event: Readonly<{ lngLat: Readonly<{ lat: number; lng: number }>; target: EventTarget | null }>) {
    if (isMapMarker(event.target)) return;
    if (view.tool !== 'add-points') return;
    const coordinate = normaliseMapCoordinate({
      latitudeDeg: event.lngLat.lat,
      longitudeDeg: event.lngLat.lng,
    });
    const point: RoutePoint = {
      id: crypto.randomUUID(),
      coordinate: {
        latitude: String(coordinate.latitudeDeg),
        longitude: String(coordinate.longitudeDeg),
      },
    };
    dispatch({ type: 'append-point', point });
  }

  function sync(nextView: MapPointView) {
    const activeDrag = drag;
    view = nextView;
    if (activeDrag !== null && (activeDrag.revision !== view.revision || activeDrag.tool !== view.tool
      || !view.sourcePointIds.includes(activeDrag.id))) {
      cancelDrag();
    }
    syncMarkers();
  }

  const removeMapClick = map.onClick(handleMapClick);
  window.addEventListener('keydown', handleEscape);
  syncMarkers();

  return {
    sync,
    dispose() {
      cancelDrag();
      window.removeEventListener('keydown', handleEscape);
      removeMapClick();
      for (const record of markers.values()) record.marker.remove();
      markers.clear();
    },
  };
}
