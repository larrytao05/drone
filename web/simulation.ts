/**
 * Simulation state machine for WEB-SIM-1 (fixture-only).
 *
 * Manages run lifecycle, scripted telemetry, blockage, and advisory state.
 * No Python, live simulator, bridge, or external dependencies.
 */

import type { SimulationLegProgress } from '../src/simulation-contract';
import type { MapGeometry } from './map-geometry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimPhase = 'ready' | 'starting' | 'running' | 'holding' | 'completed' | 'ending' | 'ended' | 'failed';

export type SimEvent = Readonly<{
  tick: number;
  label: string;
  seq?: number;
  timestamp?: string;
}>;

export type RouteSummary = Readonly<{
  name: string;
  waypointCount: number;
  plannedAltitudeM: number;
}>;

export type RouteSnapshot = Readonly<{
  name: string;
  waypointCount: number;
  plannedAltitudeM: number;
  geometry?: MapGeometry;
}>;

export type SimulationState = Readonly<{
  phase: SimPhase;
  snapshot: RouteSnapshot | null;
  blocked: boolean;
  fresh: boolean;         // telemetry freshness
  progress: number;       // 0–2 normalized route progress
  tick: number;           // simulated elapsed seconds
  events: readonly SimEvent[];
  advisory: boolean;
  mode?: 'fixture' | 'live';
  runId?: string | null;
  cleanupCompleted?: boolean;
  ownershipChecking?: boolean;
  holdRequested?: boolean;
  holdConfirmed?: boolean;
  activeLeg?: SimulationLegProgress | null;
  blockedLeg?: SimulationLegProgress | null;
  telemetry?: {
    lat: number;
    lon: number;
    altM: number;
    speedMs: number;
    northProgressM: number;
    timestamp: string;
    sampleAgeMs: number;
  } | null;
  error?: {
    code: string;
    message: string;
  } | null;
}>;

export type SimulationAction =
  | Readonly<{ type: 'start'; snapshot: RouteSnapshot }>
  | Readonly<{ type: 'block' }>
  | Readonly<{ type: 'clear' }>
  | Readonly<{ type: 'toggle-telemetry' }>
  | Readonly<{ type: 'resume' }>
  | Readonly<{ type: 'end' }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendEvent(state: SimulationState, ...labels: string[]): readonly SimEvent[] {
  return [...state.events, ...labels.map((label) => ({ tick: state.tick, label }))];
}

export function isSimulationEditLocked(state: SimulationState): boolean {
  if (state.ownershipChecking) {
    return true;
  }
  if (
    state.phase === 'starting' ||
    state.phase === 'running' ||
    state.phase === 'holding' ||
    state.phase === 'completed' ||
    state.phase === 'ending'
  ) {
    return true;
  }
  if (state.phase === 'failed' || state.phase === 'ended') {
    return state.cleanupCompleted === false;
  }
  return false;
}

export function simulationBannerText(state: SimulationState): string {
  if (state.ownershipChecking) {
    return 'Checking simulation state · Route editing paused.';
  }
  if (state.cleanupCompleted === false && (state.phase === 'failed' || state.phase === 'ended')) {
    return 'Simulation cleanup incomplete · Route editing paused.';
  }
  if (state.phase === 'completed') {
    return 'Simulation running · Route editing paused.';
  }
  if (state.phase === 'ending') {
    return 'Simulation ending · Route editing paused.';
  }
  return 'Simulation running · Route editing paused.';
}

export function isActive(state: SimulationState): boolean {
  return state.phase === 'running' || state.phase === 'holding' || state.phase === 'completed';
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createSimulationState(): SimulationState {
  return {
    phase: 'ready',
    snapshot: null,
    blocked: false,
    fresh: true,
    progress: 0,
    tick: 0,
    events: [],
    advisory: false,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function simulationReducer(state: SimulationState, action: SimulationAction): SimulationState {
  switch (action.type) {
    case 'start': {
      if (state.phase !== 'ready' && state.phase !== 'ended') return state;
      return {
        phase: 'running',
        snapshot: action.snapshot,
        blocked: false,
        fresh: true,
        progress: 0.24,
        tick: 1,
        events: [{ tick: 1, label: 'Simulation started' }],
        advisory: false,
      };
    }

    case 'block': {
      if (state.phase !== 'running' || !state.fresh || state.progress >= 1) return state;
      const tick = state.tick + 1;
      return {
        ...state,
        phase: 'holding',
        blocked: true,
        progress: 0.80,
        tick,
        events: appendEvent(
          { ...state, tick },
          'Next segment blocked',
          'Autopilot commanded hold',
          'Telemetry confirmed hold',
        ),
        advisory: true,
      };
    }

    case 'clear': {
      if (!state.blocked) return state;
      const tick = state.fresh ? state.tick + 1 : state.tick;
      return {
        ...state,
        blocked: false,
        tick,
        events: appendEvent({ ...state, tick }, 'Blockage cleared'),
      };
    }

    case 'toggle-telemetry': {
      if (!isActive(state)) return state;
      const nowFresh = !state.fresh;
      const tick = nowFresh ? state.tick + 1 : state.tick;
      return {
        ...state,
        fresh: nowFresh,
        tick,
        events: appendEvent(
          { ...state, tick },
          nowFresh ? 'Telemetry restored' : 'Telemetry unavailable',
        ),
      };
    }

    case 'resume': {
      // Resume requires: holding, not blocked, and fresh telemetry
      if (state.phase !== 'holding' || state.blocked || !state.fresh) return state;
      const tick = state.tick + 1;
      return {
        ...state,
        phase: 'running',
        progress: 1.2,
        tick,
        events: appendEvent({ ...state, tick }, 'Operator resumed the route'),
      };
    }

    case 'end': {
      if (!isActive(state)) return state;
      return {
        ...state,
        phase: 'ended',
        events: appendEvent(state, 'Simulation ended'),
      };
    }

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Derived display helpers
// ---------------------------------------------------------------------------

export function statusLabel(state: SimulationState): string {
  if (state.phase === 'ready') return 'Ready to simulate';
  if (state.phase === 'starting') return 'Starting simulation';
  if (state.phase === 'completed') return 'Mission completed';
  if (state.phase === 'ending') return 'Ending simulation';
  if (state.phase === 'failed') return 'Simulation failed';
  if (state.phase === 'ended') return 'Simulation ended';
  if (!state.fresh) return 'Telemetry unavailable';
  if (state.phase === 'holding') return 'Holding';
  return 'Running';
}

export function statusNote(state: SimulationState): string {
  if (state.phase === 'ready') return 'Ready to simulate.';
  if (state.phase === 'starting') return 'Initializing simulator and preflight health.';
  if (state.phase === 'completed') return 'Reached final waypoint. Ready for teardown.';
  if (state.phase === 'ending') return 'Tearing down simulator resources.';
  if (state.phase === 'failed') {
    return state.error?.message ?? 'Simulation encountered a failure.';
  }
  if (!state.fresh) return 'Resume requires fresh telemetry.';
  if (state.blocked) return 'Segment still blocked.';
  if (state.phase === 'holding') {
    if (state.holdRequested && !state.holdConfirmed) {
      return 'Hold requested. Waiting for autopilot telemetry confirmation.';
    }
    return 'Segment clear. Waiting for you to resume.';
  }
  return 'Following the planned route.';
}

export function formatLegDisplay(leg?: SimulationLegProgress | null): string {
  if (!leg) return '—';
  if (leg.stage === 'takeoff') return 'Transit to WP 1';
  if (leg.stage === 'completed') return 'Final waypoint reached';
  const legNum = (leg.legIndex ?? 0) + 1;
  const fromWp = (leg.fromWaypointIndex ?? 0) + 1;
  const toWp = (leg.toWaypointIndex ?? 0) + 1;
  return `Leg ${legNum} (WP ${fromWp} → WP ${toWp})`;
}

export function speedDisplay(state: SimulationState): string {
  if (!state.fresh) return '—';
  if (state.telemetry) {
    return `${state.telemetry.speedMs.toFixed(1)} m/s`;
  }
  return state.phase === 'holding' ? '0.0 m/s' : '4.0 m/s';
}

export function altitudeDisplay(state: SimulationState): string {
  if (!state.fresh) return '—';
  if (state.telemetry) {
    return `${state.telemetry.altM.toFixed(1)} m`;
  }
  return state.snapshot ? `${state.snapshot.plannedAltitudeM} m` : '—';
}

export function telemetryTimeDisplay(tick: number, timestamp?: string | null): string {
  if (timestamp) {
    try {
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date.toISOString().slice(11, 19);
      }
    } catch {
      // Fallback to tick
    }
  }
  return `00:${String(tick).padStart(2, '0')}`;
}

export function legendText(state: SimulationState, draftWaypointCount: number, blockedLabel?: string): string {
  if (!isActive(state)) return `Planned route · ${draftWaypointCount} waypoints`;
  if (!state.fresh) return `Last known position · ${telemetryTimeDisplay(state.tick, state.telemetry?.timestamp)}`;
  if (state.blocked && blockedLabel) return `Blocked segment · ${blockedLabel}`;
  return 'Simulated drone · Planned route';
}

export function canBlock(state: SimulationState): boolean {
  return state.phase === 'running' && state.fresh && state.progress < 1;
}

export function canClear(state: SimulationState): boolean {
  return state.blocked;
}

export function canResume(state: SimulationState): boolean {
  return state.phase === 'holding' && !state.blocked && state.fresh;
}

export function canEnd(state: SimulationState): boolean {
  if (state.phase === 'ready') return false;
  if (state.phase === 'ended' && state.cleanupCompleted !== false) return false;
  if (state.phase === 'failed' && state.cleanupCompleted === true) return false;
  return true;
}
