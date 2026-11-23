/**
 * Demo controls for scripted simulation events (WEB-SIM-1).
 *
 * Block/clear segment, drop/restore telemetry toggles.
 */

import type { Dispatch } from 'react';
import type { SimulationAction, SimulationState } from './simulation';
import { canBlock, canClear, isActive } from './simulation';
import styles from './DemoControls.module.css';

type DemoControlsProps = Readonly<{
  simulation: SimulationState;
  onSimAction: Dispatch<SimulationAction>;
}>;

export function DemoControls({ simulation, onSimAction }: DemoControlsProps) {
  return (
    <section className={styles.demoControls} aria-label="Demo controls">
      <p className={styles.demoHeading}>
        <strong>Demo controls</strong>{' '}
        <span className={styles.demoHint}>Scripted events</span>
      </p>
      <div className={styles.demoButtons}>
        <button
          disabled={!canBlock(simulation)}
          onClick={() => onSimAction({ type: 'block' })}
          type="button"
        >
          Block next segment
        </button>
        <button
          disabled={!canClear(simulation)}
          onClick={() => onSimAction({ type: 'clear' })}
          type="button"
        >
          Clear blockage
        </button>
        <button
          disabled={!isActive(simulation)}
          onClick={() => onSimAction({ type: 'toggle-telemetry' })}
          type="button"
        >
          {simulation.fresh ? 'Drop telemetry' : 'Restore telemetry'}
        </button>
      </div>
    </section>
  );
}
