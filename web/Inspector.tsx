import type { Dispatch } from 'react';
import type { DraftAnalysis } from './mission-input';
import type { EditorAction, EditorState } from './editor';
import { WaypointList } from './WaypointList';
import styles from './Editor.module.css';

type InspectorProps = Readonly<{
  state: EditorState;
  analysis: DraftAnalysis;
  dispatch: Dispatch<EditorAction>;
}>;

export function Inspector({ state, analysis, dispatch }: InspectorProps) {
  const selectedIndex = state.draft.points.findIndex((point) => point.id === state.selectedPointId);
  const selectedPoint = state.draft.points[selectedIndex];
  const takeoff = state.draft.takeoff ?? { latitude: '', longitude: '' };
  const selectedCoordinateIssues = selectedPoint && analysis.route.kind === 'not-calculated'
    ? analysis.route.issues.filter((issue) => issue.pointId === selectedPoint.id
      && (issue.field === 'latitude' || issue.field === 'longitude'))
    : [];

  function setTakeoffField(field: 'latitude' | 'longitude', value: string) {
    const coordinate = { ...takeoff, [field]: value };
    dispatch({
      type: 'set-takeoff',
      coordinate: coordinate.latitude === '' && coordinate.longitude === '' ? null : coordinate,
    });
  }

  return (
    <aside className={styles.inspector} aria-label="Route inspector">
      <section className={styles.settings} aria-label="Route settings">
        <div className={styles.sectionHeading}>
          <h2>Route settings</h2>
          <span>Applies to every waypoint</span>
        </div>
        <label className={styles.field}>
          <span>Height above takeoff</span>
          <span className={styles.inputWithUnit}>
            <input
              aria-label="Height above takeoff"
              inputMode="decimal"
              onChange={(event) => dispatch({ type: 'set-height', value: event.currentTarget.value })}
              value={state.draft.height}
            />
            <span>m</span>
          </span>
        </label>
        <section className={styles.takeoffSettings} aria-label="Takeoff coordinates">
          <div className={styles.sectionHeading}>
            <h2>Takeoff coordinate</h2>
          </div>
          <p className={styles.emptyList}>Optional for route calculation. Required before marking as reviewed.</p>
          <div className={styles.coordinateFields}>
            <label className={styles.field}>
              <span>Latitude</span>
              <input
                aria-label="Takeoff latitude"
                inputMode="decimal"
                onChange={(event) => setTakeoffField('latitude', event.currentTarget.value)}
                value={takeoff.latitude}
              />
            </label>
            <label className={styles.field}>
              <span>Longitude</span>
              <input
                aria-label="Takeoff longitude"
                inputMode="decimal"
                onChange={(event) => setTakeoffField('longitude', event.currentTarget.value)}
                value={takeoff.longitude}
              />
            </label>
          </div>
          {state.draft.takeoff !== null && analysis.takeoffIssues.length > 0 && (
            <section aria-label="Takeoff requirements" className={styles.takeoffIssues}>
              <ul>
                {analysis.takeoffIssues.map((issue, index) => (
                  <li key={index}>{issue.field === 'latitude' ? 'Latitude' : issue.field === 'longitude' ? 'Longitude' : 'Coordinate'}: {issue.message}</li>
                ))}
              </ul>
            </section>
          )}
        </section>
        <label className={styles.field}>
          <span>Framing</span>
          <select
            aria-label="Framing"
            onChange={(event) => {
              const kind = event.currentTarget.value;
              if (kind === '') {
                dispatch({ type: 'set-framing', kind: 'unselected' });
              } else if (kind === 'fixed' || kind === 'face-target') {
                dispatch({ type: 'set-framing', kind });
              }
            }}
            value={state.draft.framing.kind === 'unselected' ? '' : state.draft.framing.kind}
          >
            <option value="">Choose framing</option>
            <option value="fixed">Fixed heading and pitch</option>
            <option value="face-target">Face a target</option>
          </select>
        </label>
        {state.draft.framing.kind === 'fixed' && (
          <div className={styles.framingFields}>
            <label className={styles.field}>
              <span>Heading</span>
              <span className={styles.inputWithUnit}>
                <input
                  aria-label="Heading"
                  inputMode="decimal"
                  onChange={(event) => dispatch({ type: 'set-fixed-framing', field: 'heading', value: event.currentTarget.value })}
                  value={state.draft.framing.heading}
                />
                <span>°</span>
              </span>
            </label>
            <label className={styles.field}>
              <span>Gimbal pitch</span>
              <span className={styles.inputWithUnit}>
                <input
                  aria-label="Gimbal pitch"
                  inputMode="decimal"
                  onChange={(event) => dispatch({ type: 'set-fixed-framing', field: 'pitch', value: event.currentTarget.value })}
                  value={state.draft.framing.pitch}
                />
                <span>°</span>
              </span>
            </label>
          </div>
        )}
        {state.draft.framing.kind === 'face-target' && (
          <div className={styles.framingFields}>
            <label className={styles.field}>
              <span>Target latitude</span>
              <input
                aria-label="Target latitude"
                inputMode="decimal"
                onChange={(event) => dispatch({ type: 'set-target-coordinate', field: 'latitude', value: event.currentTarget.value })}
                value={state.draft.framing.coordinate.latitude}
              />
            </label>
            <label className={styles.field}>
              <span>Target longitude</span>
              <input
                aria-label="Target longitude"
                inputMode="decimal"
                onChange={(event) => dispatch({ type: 'set-target-coordinate', field: 'longitude', value: event.currentTarget.value })}
                value={state.draft.framing.coordinate.longitude}
              />
            </label>
            <label className={styles.field}>
              <span>Target height</span>
              <input
                aria-label="Target height"
                inputMode="decimal"
                onChange={(event) => dispatch({ type: 'set-target-height', value: event.currentTarget.value })}
                value={state.draft.framing.height}
              />
            </label>
          </div>
        )}
      </section>

      <section className={styles.waypoints} aria-label="Waypoints">
        <div className={styles.sectionHeading}>
          <h2>Waypoints</h2>
          <span>{state.draft.points.length}</span>
        </div>
        <WaypointList
          dispatch={dispatch}
          points={state.draft.points}
          selectedPointId={state.selectedPointId}
        />
      </section>

      <section className={styles.selectedPoint} aria-label="Selected waypoint">
        <div className={styles.sectionHeading}>
          <h2>Selected waypoint</h2>
          {selectedPoint && <span>{String(selectedIndex + 1).padStart(2, '0')}</span>}
        </div>
        {selectedPoint ? (
          <div className={styles.coordinateFields}>
            <label className={styles.field}>
              <span>Latitude</span>
              <input
                aria-label="Selected latitude"
                aria-invalid={selectedCoordinateIssues.some((issue) => issue.field === 'latitude') || undefined}
                inputMode="decimal"
                onChange={(event) => dispatch({ type: 'set-point-coordinate', id: selectedPoint.id, field: 'latitude', value: event.currentTarget.value })}
                value={selectedPoint.coordinate.latitude}
              />
            </label>
            <label className={styles.field}>
              <span>Longitude</span>
              <input
                aria-label="Selected longitude"
                aria-invalid={selectedCoordinateIssues.some((issue) => issue.field === 'longitude') || undefined}
                inputMode="decimal"
                onChange={(event) => dispatch({ type: 'set-point-coordinate', id: selectedPoint.id, field: 'longitude', value: event.currentTarget.value })}
                value={selectedPoint.coordinate.longitude}
              />
            </label>
          </div>
        ) : (
          <p className={styles.emptyList}>Select a waypoint to edit its coordinates.</p>
        )}
        {selectedCoordinateIssues.length > 0 && (
          <div role="alert" className={styles.fieldHint}>
            <ul>
              {selectedCoordinateIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </aside>
  );
}
