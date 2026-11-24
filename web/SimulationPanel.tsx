/**
 * Simulation side panel for WEB-SIM-1.
 *
 * Shows ready/ended state with Start, or running/holding state with
 * telemetry, events, advisory, Resume and End controls.
 */

import type { Dispatch } from 'react';
import type { RouteSummary, SimulationAction, SimulationState } from './simulation';
import {
  altitudeDisplay,
  canEnd,
  canResume,
  formatLegDisplay,
  speedDisplay,
  statusLabel,
  statusNote,
  telemetryTimeDisplay,
} from './simulation';
import styles from './SimulationPanel.module.css';

type SimulationPanelProps = Readonly<{
  simulation: SimulationState;
  draftSummary: RouteSummary;
  onStart: () => void;
  onSimAction: Dispatch<SimulationAction>;
  validationError?: string | null | undefined;
  modeBadge?: string | undefined;
}>;

export function SimulationPanel({
  simulation,
  draftSummary,
  onStart,
  onSimAction,
  validationError,
  modeBadge,
}: SimulationPanelProps) {
  const isIdleOrCleaned =
    simulation.phase === 'ready' ||
    (simulation.phase === 'ended' && simulation.cleanupCompleted !== false) ||
    (simulation.phase === 'failed' && simulation.cleanupCompleted === true);

  if (isIdleOrCleaned) {
    const heading =
      simulation.phase === 'ended'
        ? 'Simulation ended'
        : simulation.phase === 'failed'
        ? 'Simulation failed'
        : 'Ready to simulate';

    return (
      <section className={styles.simPanel} aria-label="Simulation status">
        {modeBadge && <span className={styles.simBadge}>{modeBadge}</span>}
        <h2>{heading}</h2>
        <div className={styles.simRouteSummary} role="group" aria-label="Route to simulate">
          <p className={styles.simRouteName}>
            <strong>{draftSummary.name || 'Untitled route'}</strong>
          </p>
          <p className={styles.simMeta}>
            {draftSummary.waypointCount} waypoints · {draftSummary.plannedAltitudeM} m planned altitude
          </p>
        </div>
        {validationError && (
          <p className={styles.simError} role="alert">
            {validationError}
          </p>
        )}
        <button
          className={styles.simPrimary}
          id="start-simulation"
          onClick={onStart}
          type="button"
        >
          Start simulation
        </button>
        {(simulation.phase === 'ended' || simulation.phase === 'failed') &&
          (simulation.events.length > 0 || simulation.error) && (
            <div className={styles.simEvents} role="group" aria-label="Previous run">
              <h3>Previous run</h3>
              {simulation.snapshot && (
                <p>
                  {simulation.snapshot.name} · {simulation.snapshot.waypointCount} waypoints ·{' '}
                  {simulation.snapshot.plannedAltitudeM} m planned altitude
                </p>
              )}
              {simulation.error && (
                <p className={styles.simError}>
                  <strong>Error:</strong> {simulation.error.message}
                </p>
              )}
              <ol>
                {simulation.events.map((event, index) => (
                  <li key={index}>{event.label}</li>
                ))}
              </ol>
            </div>
          )}
      </section>
    );
  }

  return (
    <section className={styles.simPanel} aria-label="Simulation status">
      {modeBadge && <span className={styles.simBadge}>{modeBadge}</span>}
      <h2>{statusLabel(simulation)}</h2>
      <p className={styles.simMeta}>{statusNote(simulation)}</p>

      <dl className={styles.simTelemetry}>
        <dt>Speed</dt>
        <dd>{speedDisplay(simulation)}</dd>
        <dt>Altitude</dt>
        <dd>{altitudeDisplay(simulation)}</dd>
        {simulation.activeLeg && (
          <>
            <dt>Active leg</dt>
            <dd>{formatLegDisplay(simulation.activeLeg)}</dd>
          </>
        )}
        {simulation.blockedLeg && (simulation.blocked || simulation.phase === 'holding') && (
          <>
            <dt>Blocked leg</dt>
            <dd>{formatLegDisplay(simulation.blockedLeg)}</dd>
          </>
        )}
        <dt>Last telemetry</dt>
        <dd>{telemetryTimeDisplay(simulation.tick, simulation.telemetry?.timestamp)}</dd>
      </dl>

      <div className={styles.simActions}>
        <button
          className={styles.simPrimary}
          disabled={!canResume(simulation)}
          onClick={() => onSimAction({ type: 'resume' })}
          type="button"
        >
          Resume
        </button>
        <button
          className={styles.secondaryButton}
          disabled={!canEnd(simulation)}
          onClick={() => onSimAction({ type: 'end' })}
          type="button"
        >
          End simulation
        </button>
      </div>

      <div className={styles.simEvents}>
        <h3>Run events</h3>
        <ol>
          {simulation.events.map((event, index) => (
            <li key={index}>{event.label}</li>
          ))}
        </ol>
      </div>

      {simulation.advisory && (
        <p className={styles.simAdvisory}>
          <strong>Assistant recommendation</strong>
          <br />
          Stay in hold until the segment is clear and telemetry is available.
        </p>
      )}
    </section>
  );
}
