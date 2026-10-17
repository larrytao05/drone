'use client';

import { useEffect, useRef, useState } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import { parseNumericText } from './numeric-input';
import type { MapPointAction, MapPointView } from './map-points';
import { createMapPoints } from './map-points';
import styles from './MissionMap.module.css';

type MapStatus = 'loading' | 'ready' | 'unavailable';
type Camera = Readonly<{ latitude: number; longitude: number; zoom: number }>;
type LocatorErrors = Readonly<{ latitude: string | null; longitude: string | null }>;

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
  pointView: MapPointView;
  onPointAction: (action: MapPointAction) => void;
}>;

export function MissionMap({ pointView, onPointAction }: MissionMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const pointAdapterRef = useRef<ReturnType<typeof createMapPoints> | null>(null);
  const pointViewRef = useRef(pointView);
  const onPointActionRef = useRef(onPointAction);
  const [status, setStatus] = useState<MapStatus>('loading');
  const [moving, setMoving] = useState(false);
  const [camera, setCamera] = useState(initialCamera);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [errors, setErrors] = useState<LocatorErrors>({ latitude: null, longitude: null });

  pointViewRef.current = pointView;
  onPointActionRef.current = onPointAction;

  useEffect(() => {
    pointAdapterRef.current?.sync(pointView);
  }, [pointView]);

  useEffect(() => {
    let disposed = false;
    let failed = false;
    let map: import('maplibre-gl').Map | null = null;

    function failMap() {
      if (disposed || failed) return;
      failed = true;
      const failedMap = map;
      map = null;
      pointAdapterRef.current?.dispose();
      pointAdapterRef.current = null;
      if (failedMap !== null) {
        if (mapRef.current === failedMap) mapRef.current = null;
        failedMap.remove();
      }
      setMoving(false);
      setStatus('unavailable');
    }

    async function createMap() {
      try {
        const { Map, Marker, NavigationControl, setWorkerUrl } = await import('maplibre-gl');
        if (disposed || container.current === null) return;
        setWorkerUrl('/maplibre-gl-worker.mjs');

        map = new Map({
          container: container.current,
          style: localStyle,
          center: [initialCamera.longitude, initialCamera.latitude],
          zoom: initialCamera.zoom,
          bearing: 0,
          pitch: 0,
          maxPitch: 0,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: false,
        });
        mapRef.current = map;
        map.keyboard.disableRotation();
        map.touchZoomRotate.disableRotation();
        const currentMap = map;
        pointAdapterRef.current = createMapPoints(
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
          pointViewRef.current,
          (action) => onPointActionRef.current(action),
        );

        map.on('error', failMap);
        map.on('webglcontextlost', failMap);
        map.on('load', () => {
          if (disposed || failed || map === null) return;
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

    void createMap();

    return () => {
      disposed = true;
      pointAdapterRef.current?.dispose();
      pointAdapterRef.current = null;
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
      <div aria-label="Map canvas" className={styles.canvas} ref={container} />
      <div className={styles.mapPanel}>
        <form aria-label="Map locator" className={styles.locator} onSubmit={(event) => {
          event.preventDefault();
          locate();
        }}>
          <label>
            <span>Locator latitude</span>
            <input
              aria-invalid={errors.latitude !== null}
              inputMode="decimal"
              onChange={(event) => setLatitude(event.currentTarget.value)}
              value={latitude}
            />
          </label>
          <label>
            <span>Locator longitude</span>
            <input
              aria-invalid={errors.longitude !== null}
              inputMode="decimal"
              onChange={(event) => setLongitude(event.currentTarget.value)}
              value={longitude}
            />
          </label>
          <button disabled={status !== 'ready'} type="submit">Locate</button>
          {(errors.latitude !== null || errors.longitude !== null) && (
            <p className={styles.locatorError} role="alert">
              {[errors.latitude, errors.longitude].filter((error) => error !== null).join(' ')}
            </p>
          )}
        </form>
      </div>
      <div className={styles.mapStatusPanel}>
        <div aria-label="Map status" aria-live="polite" aria-busy={status === 'loading' || moving} className={styles.status} role="status">
          <span>{statusText}</span>
          {status === 'ready' && <span aria-label="Map view">{cameraText(camera)}</span>}
        </div>
        {status === 'unavailable' && <p className={styles.mapError}>The local map renderer is unavailable. Route editing and saving remain available.</p>}
        <p className={styles.status}>Imagery is not connected.</p>
      </div>
    </section>
  );
}
