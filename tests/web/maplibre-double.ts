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
  attributionControl?: boolean;
}>;

type CameraOptions = Readonly<{ center: readonly [number, number]; duration: number }>;
type MapEvent = Readonly<{ lngLat: Readonly<{ lat: number; lng: number }>; originalEvent: MouseEvent }>;
type Listener = (event?: MapEvent) => void;

export class FakeMap {
  readonly options: MapOptions;
  readonly canvas = document.createElement('canvas');
  readonly disabledRotations: string[] = [];
  readonly controls: unknown[] = [];
  readonly controlPositions: string[] = [];
  readonly handlers = new globalThis.Map<string, Listener[]>();
  center: readonly [number, number];
  zoom: number;
  removeCount = 0;

  constructor(options: MapOptions) {
    if (throwOnConstruction) throw new Error('WebGL is unavailable');
    this.options = options;
    this.center = options.center ?? [0, 0];
    this.zoom = options.zoom ?? 0;
    options.container.append(this.canvas);
    instances.push(this);
    queueMicrotask(() => this.emit('load'));
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
    for (const listener of this.handlers.get(type) ?? []) listener();
  }

  emitClick(longitude: number, latitude: number, originalEvent = new MouseEvent('click')) {
    const event = { lngLat: { lat: latitude, lng: longitude }, originalEvent };
    for (const listener of this.handlers.get('click') ?? []) listener(event);
  }

  getContainer() {
    return this.options.container;
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
    this.canvas.remove();
  }
}

export class NavigationControl {
  constructor(readonly options: Readonly<{ showZoom: boolean; showCompass: boolean }>) {}
}

export class Marker {
  coordinate: readonly [number, number] = [0, 0];

  constructor(readonly options: Readonly<{ element: HTMLButtonElement; anchor: 'center' }>) {}

  getElement() {
    return this.options.element;
  }

  setLngLat(coordinate: readonly [number, number]) {
    this.coordinate = coordinate;
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
let throwOnConstruction = false;

export function resetMaplibreDouble() {
  instances.length = 0;
  throwOnConstruction = false;
  configuredWorkerUrl = null;
}

export function failMapConstruction() {
  throwOnConstruction = true;
}

export function createdMaps(): readonly FakeMap[] {
  return instances;
}

export { FakeMap as Map };

let configuredWorkerUrl: string | null = null;

export function setWorkerUrl(url: string) {
  configuredWorkerUrl = url;
}

export function workerUrl(): string | null {
  return configuredWorkerUrl;
}
