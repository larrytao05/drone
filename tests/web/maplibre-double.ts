type MapOptions = Readonly<{
  container: HTMLElement;
  style: unknown;
  projection?: Readonly<{ type: 'mercator' }>;
  center?: readonly [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  maxPitch?: number;
  dragRotate?: boolean;
  pitchWithRotate?: boolean;
  touchPitch?: boolean;
  attributionControl?: boolean | Readonly<{ compact?: boolean }>;
  transformRequest?: (url: string) => Readonly<{ url: string; cache?: RequestCache }>;
}>;

type CameraOptions = Readonly<{ center: readonly [number, number]; duration: number }>;
type MarkerOptions = Readonly<{
  element: HTMLDivElement | HTMLButtonElement;
  anchor: 'center';
  offset?: readonly [number, number];
  rotation?: number;
  rotationAlignment?: 'map' | 'viewport' | 'auto';
}>;
type MapEvent = Readonly<{ lngLat: Readonly<{ lat: number; lng: number }>; originalEvent: MouseEvent }>;
type Listener = (event?: MapEvent) => void;

export class FakeMap {
  readonly options: MapOptions;
  readonly canvas = document.createElement('canvas');
  readonly disabledRotations: string[] = [];
  readonly controls: unknown[] = [];
  readonly controlPositions: string[] = [];
  readonly handlers = new globalThis.Map<string, Listener[]>();
  readonly sources = new globalThis.Map<string, { type: string; data: unknown; setData(data: unknown): void }>();
  readonly layers = new globalThis.Map<string, unknown>();
  center: readonly [number, number];
  zoom: number;
  removeCount = 0;
  loaded = false;
  projection: Readonly<{ type: 'mercator' }> | null = null;
  removeSnapshot: Readonly<{ sources: readonly string[]; layers: readonly string[]; headings: number }> | null = null;

  constructor(options: MapOptions) {
    if (throwOnConstruction) throw new Error('WebGL is unavailable');
    this.options = options;
    this.center = options.center ?? [0, 0];
    this.zoom = options.zoom ?? 0;
    options.container.append(this.canvas);
    instances.push(this);
    if (!deferLoad) queueMicrotask(() => this.emit('load'));
  }

  readonly keyboard = {
    disableRotation: () => this.disabledRotations.push('keyboard'),
  };

  readonly touchZoomRotate = {
    disableRotation: () => this.disabledRotations.push('touch'),
  };

  on(type: string, listener: Listener) {
    const listeners = this.handlers.get(type) ?? [];
    listeners.push(listener);
    this.handlers.set(type, listeners);
    return this;
  }

  off(type: string, listener: Listener) {
    const listeners = this.handlers.get(type) ?? [];
    this.handlers.set(type, listeners.filter((candidate) => candidate !== listener));
    return this;
  }

  emit(type: string) {
    if (type === 'load') this.loaded = true;
    for (const listener of this.handlers.get(type) ?? []) listener();
  }

  emitClick(longitude: number, latitude: number, originalEvent = new MouseEvent('click')) {
    const event = { lngLat: { lat: latitude, lng: longitude }, originalEvent };
    for (const listener of this.handlers.get('click') ?? []) listener(event);
  }

  getContainer() {
    return this.options.container;
  }

  setProjection(projection: Readonly<{ type: 'mercator' }>) {
    if (!this.loaded) throw new Error('Projection can only change after style load');
    this.projection = projection;
    return this;
  }

  unproject(point: [number, number]) {
    const rect = this.options.container.getBoundingClientRect();
    return {
      lng: this.center[0] + (point[0] - rect.width / 2) / 10000,
      lat: this.center[1] - (point[1] - rect.height / 2) / 10000,
    };
  }

  addControl(control: unknown, position: string) {
    this.controls.push(control);
    this.controlPositions.push(position);
    return this;
  }

  addSource(id: string, source: { type: string; data: unknown }) {
    this.sources.set(id, {
      ...source,
      setData(data: unknown) {
        this.data = data;
      },
    });
    return this;
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
    return this;
  }

  addLayer(layer: { id: string }) {
    this.layers.set(layer.id, layer);
    return this;
  }

  getLayer(id: string) {
    return this.layers.get(id);
  }

  removeLayer(id: string) {
    this.layers.delete(id);
    return this;
  }

  getCenter() {
    return { lng: this.center[0], lat: this.center[1] };
  }

  getZoom() {
    return this.zoom;
  }

  easeTo(options: CameraOptions) {
    this.emit('movestart');
    this.center = options.center;
    this.emit('moveend');
    return this;
  }

  remove() {
    this.removeCount += 1;
    this.removeSnapshot = {
      sources: [...this.sources.keys()],
      layers: [...this.layers.keys()],
      headings: this.options.container.querySelectorAll('.mission-heading-marker').length,
    };
    this.canvas.remove();
  }
}

export class NavigationControl {
  constructor(readonly options: Readonly<{ showZoom: boolean; showCompass: boolean }>) {}
}

export class AttributionControl {
  constructor(readonly options: Readonly<{ compact: boolean }>) {}
}

export class Marker {
  coordinate: readonly [number, number] = [0, 0];
  rotation: number;

  constructor(readonly options: MarkerOptions) {
    this.rotation = options.rotation ?? 0;
    allMarkers.push(this);
  }

  getElement() {
    return this.options.element;
  }

  setLngLat(coordinate: readonly [number, number]) {
    this.coordinate = coordinate;
    return this;
  }

  setRotation(rotation: number) {
    this.rotation = rotation;
    return this;
  }

  addTo(map: FakeMap) {
    map.getContainer().append(this.options.element);
    return this;
  }

  remove() {
    this.options.element.remove();
  }
}

const instances: FakeMap[] = [];
const allMarkers: Marker[] = [];
let throwOnConstruction = false;
let deferLoad = false;

export function resetMaplibreDouble() {
  instances.length = 0;
  allMarkers.length = 0;
  throwOnConstruction = false;
  deferLoad = false;
  configuredWorkerUrl = null;
}

export function failMapConstruction() {
  throwOnConstruction = true;
}

export function deferMapLoad() {
  deferLoad = true;
}

export function createdMaps(): readonly FakeMap[] {
  return instances;
}

export function createdMarkers(): readonly Marker[] {
  return allMarkers;
}

export { FakeMap as Map };

let configuredWorkerUrl: string | null = null;

export function setWorkerUrl(url: string) {
  configuredWorkerUrl = url;
}

export function workerUrl(): string | null {
  return configuredWorkerUrl;
}
