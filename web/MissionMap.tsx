'use client';

import { useEffect, useRef, useState } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import { z } from 'zod';
import { parseNumericText } from './numeric-input';
import type { MapSourceAction, MapSourceView } from './map-source';
import { createMapSource } from './map-source';
import type { MapGeometry } from './map-geometry';
import { createMapPreview } from './map-preview';
import styles from './MissionMap.module.css';

type MapStatus = 'loading' | 'ready' | 'unavailable';
type Camera = Readonly<{ latitude: number; longitude: number; zoom: number }>;
type LocatorErrors = Readonly<{ latitude: string | null; longitude: string | null }>;
const mapConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('provider'), styleUrl: z.string().url() }),
  z.object({ kind: z.literal('missing') }),
]);

const initialCamera: Camera = { latitude: 37.7749, longitude: -122.4194, zoom: 15 };
const localStyle: StyleSpecification = {
  version: 8 as const,
  name: 'Local background',
  projection: { type: 'mercator' },
  sources: {},
  layers: [{
    id: 'background',
    type: 'background' as const,
    paint: { 'background-color': '#d9e2df' },
  }],
};

function coordinateError(value: number | null, minimum: number, maximum: number): string | null {
  if (value === null) return 'Enter a complete finite decimal number.';
  if (value < minimum || value > maximum) return `Enter a value between ${minimum} and ${maximum}.`;
  return null;
}

function cameraText(camera: Camera): string {
  return `Center ${camera.latitude.toFixed(4)}, ${camera.longitude.toFixed(4)} · zoom ${camera.zoom.toFixed(1)}`;
}

type MissionMapProps = Readonly<{
  geometry: MapGeometry;
  sourceView: MapSourceView;
  onSourceAction: (action: MapSourceAction) => void;
}>;

export function MissionMap({ geometry, sourceView, onSourceAction }: MissionMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const sourceAdapterRef = useRef<ReturnType<typeof createMapSource> | null>(null);
  const previewAdapterRef = useRef<ReturnType<typeof createMapPreview> | null>(null);
  const geometryRef = useRef(geometry);
  const sourceViewRef = useRef(sourceView);
  const onSourceActionRef = useRef(onSourceAction);
  const [status, setStatus] = useState<MapStatus>('loading');
  const [localMode, setLocalMode] = useState(false);
  const [moving, setMoving] = useState(false);
  const [camera, setCamera] = useState(initialCamera);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [errors, setErrors] = useState<LocatorErrors>({ latitude: null, longitude: null });

  sourceViewRef.current = sourceView;
  geometryRef.current = geometry;
  onSourceActionRef.current = onSourceAction;

  useEffect(() => {
    sourceAdapterRef.current?.sync(sourceView);
  }, [sourceView]);

  useEffect(() => {
    previewAdapterRef.current?.sync(geometry);
  }, [geometry]);

  useEffect(() => {
    let disposed = false;
    let failed = false;
    let map: import('maplibre-gl').Map | null = null;
    const configAbort = new AbortController();

    function failMap() {
      if (disposed || failed) return;
      failed = true;
      const failedMap = map;
      map = null;
      sourceAdapterRef.current?.dispose();
      sourceAdapterRef.current = null;
      previewAdapterRef.current?.dispose();
      previewAdapterRef.current = null;
      if (failedMap !== null) {
        if (mapRef.current === failedMap) mapRef.current = null;
        failedMap.remove();
      }
      setMoving(false);
      setStatus('unavailable');
    }

    async function createMap(style: StyleSpecification | string) {
      try {
        const { AttributionControl, Map, Marker, NavigationControl, setWorkerUrl } = await import('maplibre-gl');
        if (disposed || container.current === null) return;
        setWorkerUrl('/maplibre-gl-worker.mjs');

        map = new Map({
          container: container.current,
          style,
          center: [initialCamera.longitude, initialCamera.latitude],
          zoom: initialCamera.zoom,
          bearing: 0,
          pitch: 0,
          maxPitch: 0,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: false,
          ...(style === localStyle ? {} : {
            transformRequest: (url: string) => ({ url, cache: 'no-store' }),
          }),
        });
        if (style !== localStyle) {
          map.addControl(new AttributionControl({ compact: false }), 'bottom-left');
        }
        mapRef.current = map;
        map.keyboard.disableRotation();
        map.touchZoomRotate.disableRotation();
        const currentMap = map;
        sourceAdapterRef.current = createMapSource(
          {
            project: (coordinate) => currentMap.project(coordinate),
            unproject: (point) => currentMap.unproject(point),
            createMarker: (element, coordinate) => new Marker({ element, anchor: 'center' })
              .setLngLat(coordinate)
              .addTo(currentMap),
            onClick: (handler) => {
              const listener = (event: import('maplibre-gl').MapMouseEvent) => handler({
                lngLat: event.lngLat,
                target: event.originalEvent.target,
              });
              currentMap.on('click', listener);
              return () => currentMap.off('click', listener);
            },
          },
          sourceViewRef.current,
          (action) => onSourceActionRef.current(action),
        );
        previewAdapterRef.current = createMapPreview({
          addLineSource: (data) => currentMap.addSource('calculated-route', { type: 'geojson', data }),
          setLineData: (data) => {
            const source = currentMap.getSource('calculated-route');
            if (source === undefined || !('setData' in source) || typeof source.setData !== 'function') {
              throw new Error('Calculated route source is unavailable');
            }
            source.setData(data);
          },
          addLineLayer: () => currentMap.addLayer({
            id: 'calculated-route-line',
            type: 'line',
            source: 'calculated-route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#176b8a', 'line-width': 3, 'line-opacity': 0.85 },
          }),
          removeLineLayer: () => {
            if (currentMap.getLayer('calculated-route-line') !== undefined) currentMap.removeLayer('calculated-route-line');
          },
          removeLineSource: () => {
            if (currentMap.getSource('calculated-route') !== undefined) currentMap.removeSource('calculated-route');
          },
          createHeadingMarker: (element, coordinate, rotation) => new Marker({
            element,
            anchor: 'center',
            offset: [0, -30],
            rotation,
            rotationAlignment: 'map',
          })
            .setLngLat(coordinate)
            .addTo(currentMap),
        }, geometryRef.current);

        map.on('error', failMap);
        map.on('webglcontextlost', failMap);
        map.on('load', () => {
          if (disposed || failed || map === null) return;
          try {
            map.setProjection({ type: 'mercator' });
          } catch {
            failMap();
            return;
          }
          previewAdapterRef.current?.loaded();
          setStatus('ready');
          setCamera({
            latitude: map.getCenter().lat,
            longitude: map.getCenter().lng,
            zoom: map.getZoom(),
          });
        });
        map.on('movestart', () => {
          if (!disposed && !failed) setMoving(true);
        });
        map.on('moveend', () => {
          if (disposed || failed || map === null) return;
          setCamera({
            latitude: map.getCenter().lat,
            longitude: map.getCenter().lng,
            zoom: map.getZoom(),
          });
          setMoving(false);
        });
        map.addControl(new NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
      } catch {
        if (!disposed) failMap();
      }
    }

    async function loadConfiguration() {
      try {
        const response = await fetch('/api/map-config', { cache: 'no-store', signal: configAbort.signal });
        if (!response.ok || disposed) {
          if (!disposed) failMap();
          return;
        }
        const config = mapConfigSchema.parse(await response.json());
        if (disposed) return;
        if (config.kind === 'missing') {
          setStatus('unavailable');
          return;
        }
        setLocalMode(config.kind === 'local');
        await createMap(config.kind === 'local' ? localStyle : config.styleUrl);
      } catch {
        if (!disposed) failMap();
      }
    }

    void loadConfiguration();

    return () => {
      disposed = true;
      configAbort.abort();
      sourceAdapterRef.current?.dispose();
      sourceAdapterRef.current = null;
      previewAdapterRef.current?.dispose();
      previewAdapterRef.current = null;
      if (map !== null) {
        map.remove();
        if (mapRef.current === map) mapRef.current = null;
      }
    };
  }, []);

  function locate() {
    const latitudeValue = parseNumericText(latitude);
    const longitudeValue = parseNumericText(longitude);
    const nextErrors = {
      latitude: coordinateError(latitudeValue, -90, 90),
      longitude: coordinateError(longitudeValue, -180, 180),
    };
    setErrors(nextErrors);
    if (nextErrors.latitude !== null || nextErrors.longitude !== null) return;

    const map = mapRef.current;
    if (map === null || latitudeValue === null || longitudeValue === null) return;
    setMoving(true);
    map.easeTo({ center: [longitudeValue, latitudeValue], duration: 350 });
  }

  const statusText = status === 'loading' ? 'Loading map'
    : status === 'ready' ? 'Map ready' : 'Map rendering unavailable';

  return (
    <section
      aria-busy={status === 'loading' || moving}
      aria-label="Mission map"
      className={styles.mapSurface}
      role="region"
    >
      <div className={styles.mapFrame}>
        <div aria-label="Map canvas" className={styles.canvas} ref={container} />
        <div className={styles.mapPanel}>
          <form aria-label="Map locator" className={styles.locator} onSubmit={(event) => {
            event.preventDefault();
            locate();
          }}>
            <label>
              <span>Locator latitude</span>
              <input aria-invalid={errors.latitude !== null} inputMode="decimal" onChange={(event) => setLatitude(event.currentTarget.value)} value={latitude} />
            </label>
            <label>
              <span>Locator longitude</span>
              <input aria-invalid={errors.longitude !== null} inputMode="decimal" onChange={(event) => setLongitude(event.currentTarget.value)} value={longitude} />
            </label>
            <button disabled={status !== 'ready'} type="submit">Locate</button>
            {(errors.latitude !== null || errors.longitude !== null) && (
              <p className={styles.locatorError} role="alert">
                {[errors.latitude, errors.longitude].filter((error) => error !== null).join(' ')}
              </p>
            )}
          </form>
        </div>
      </div>
      <div className={styles.mapStatusPanel}>
        <div aria-label="Map status" aria-live="polite" aria-busy={status === 'loading' || moving} className={styles.status} role="status">
          <span>{statusText}</span>
          {status === 'ready' && <span aria-label="Map view">{cameraText(camera)}</span>}
        </div>
        {status === 'unavailable' && <p className={styles.mapError}>Map imagery is unavailable. Route editing and saving remain available.</p>}
        {localMode && <p className={styles.status}>Imagery is not connected.</p>}
      </div>
    </section>
  );
}
