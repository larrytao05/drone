'use client';

import type { MapGeometry } from './map-geometry';
import type { SimulationState } from './simulation';
import { legendText } from './simulation';
import { getBlockedSegmentLabel, getRouteCoordinates } from './map-simulation';
import styles from './SimulationOverlay.module.css';

type SimulationOverlayProps = Readonly<{
  geometry: MapGeometry;
  draftWaypointCount: number;
  simulation: SimulationState;
  mapStatus?: 'loading' | 'ready' | 'unavailable';
}>;

export function SimulationOverlay({
  geometry,
  draftWaypointCount,
  simulation,
  mapStatus,
}: SimulationOverlayProps) {
  const routeCoords = getRouteCoordinates(geometry);
  const blockedLabel = getBlockedSegmentLabel(routeCoords.length);

  return (
    <div className={styles.simMapOverlay} aria-label="Simulation map overlay">
      <span className={styles.simLegend} aria-label="Map legend">
        {legendText(simulation, draftWaypointCount, blockedLabel)}
      </span>

      {mapStatus === 'unavailable' && (
        <div className={styles.simUnavailableState} role="status">
          Simulation map view is unavailable while map rendering is offline.
        </div>
      )}
    </div>
  );
}
