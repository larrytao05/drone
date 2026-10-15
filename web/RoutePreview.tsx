import type { DraftAnalysis } from './mission-input';
import type { MissionDraft } from './editor';
import type { MapGeometry } from './map-geometry';
import styles from './Editor.module.css';

type RouteIssue = Extract<DraftAnalysis['route'], { kind: 'not-calculated' }>['issues'][number];

type RoutePreviewProps = Readonly<{
  analysis: DraftAnalysis;
  geometry: MapGeometry;
  draft: MissionDraft;
}>;

function issueFieldLabel(issue: RouteIssue): string {
  switch (issue.field) {
    case 'latitude': return 'Latitude';
    case 'longitude': return 'Longitude';
    case 'height': return issue.path[0] === 'framing' ? 'Target height' : 'Height above takeoff';
    case 'heading': return 'Heading';
    case 'pitch': return 'Gimbal pitch';
    case 'framing': return 'Framing';
    case undefined: return 'Route';
    default: return 'Route';
  }
}

function issueLabel(issue: RouteIssue, draft: MissionDraft): string {
  const message = `${issueFieldLabel(issue)}: ${issue.message}`;
  if (issue.pointId === undefined) return message;
  const pointIndex = draft.points.findIndex((point) => point.id === issue.pointId);
  return pointIndex === -1 ? message : `Waypoint ${pointIndex + 1}: ${message}`;
}

export function RoutePreview({ analysis, geometry, draft }: RoutePreviewProps) {
  const hasRouteInput = draft.points.length > 0 || draft.height !== '' || draft.framing.kind !== 'unselected';

  return (
    <section className={styles.preview} aria-label="Route preview">
      <div>
        <span className={styles.eyebrow}>Preview</span>
        <h2>Nominal route</h2>
      </div>
      {analysis.route.kind === 'calculated' ? (
        <div className={styles.previewContent}>
          <p className={styles.previewDescription}>Calculated values from the current route settings.</p>
          <div className={styles.previewTableScroll}>
            <table className={styles.previewTable} aria-label="Calculated waypoints">
              <thead>
                <tr>
                  <th scope="col">Waypoint</th>
                  <th scope="col">Latitude</th>
                  <th scope="col">Longitude</th>
                  <th scope="col">Height above takeoff (m)</th>
                  <th scope="col">Heading (°)</th>
                  <th scope="col">Gimbal pitch (°)</th>
                </tr>
              </thead>
              <tbody>
                {analysis.route.waypoints.map((waypoint, index) => (
                  <tr key={`${index}:${waypoint.coordinate.latitudeDeg}:${waypoint.coordinate.longitudeDeg}`}>
                    <td>{String(index + 1).padStart(2, '0')}</td>
                    <td>{String(waypoint.coordinate.latitudeDeg)}</td>
                    <td>{String(waypoint.coordinate.longitudeDeg)}</td>
                    <td>{String(waypoint.heightAboveTakeoffM)}</td>
                    <td>{String(waypoint.headingDeg)}</td>
                    <td>{String(waypoint.gimbalPitchDeg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={styles.previewContent}>
          {hasRouteInput ? (
            <ul className={styles.previewIssues} aria-label="Route calculation issues">
              {analysis.route.issues.map((issue, index) => (
                <li key={index}>
                  {issueLabel(issue, draft)}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.previewDescription}>Add at least two waypoints and complete route settings to see calculated values.</p>
          )}
        </div>
      )}
      {geometry.omittedPointIds.length > 0 && (
        <p className={styles.projectionNotice} role="note">
          {analysis.route.kind === 'calculated'
            ? geometry.omittedPointIds.length === 1
              ? 'A polar waypoint is kept in the route table but omitted from the map because it is outside the map projection.'
              : `${geometry.omittedPointIds.length} polar waypoints are kept in the route table but omitted from the map because they are outside the map projection.`
            : geometry.omittedPointIds.length === 1
              ? 'A polar waypoint remains in the route source and is omitted from the map because it is outside the map projection; calculated values are unavailable.'
              : `${geometry.omittedPointIds.length} polar waypoints remain in the route source and are omitted from the map because they are outside the map projection; calculated values are unavailable.`}
        </p>
      )}
    </section>
  );
}
