import { describe, expect, it } from 'vitest';
import {
  canBlock, canClear, canResume, createSimulationState, isActive,
  legendText, simulationReducer, statusLabel, statusNote,
  type SimulationState,
} from '../../web/simulation.js';

function startState(): SimulationState {
  return simulationReducer(createSimulationState(), {
    type: 'start', snapshot: { name: 'Survey', waypointCount: 3, plannedAltitudeM: 30 },
  });
}

function holdState(): SimulationState {
  const running = startState();
  return simulationReducer(running, { type: 'block' });
}

function clearedHoldState(): SimulationState {
  return simulationReducer(holdState(), { type: 'clear' });
}

describe('simulation state machine', () => {
  it('creates a ready state', () => {
    const state = createSimulationState();
    expect(state.phase).toBe('ready');
    expect(state.blocked).toBe(false);
    expect(state.fresh).toBe(true);
    expect(state.events).toEqual([]);
    expect(isActive(state)).toBe(false);
  });

  it('starts a simulation from ready', () => {
    const state = startState();
    expect(state.phase).toBe('running');
    expect(state.progress).toBe(0.24);
    expect(state.tick).toBe(1);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.label).toBe('Simulation started');
    expect(state.snapshot?.name).toBe('Survey');
    expect(state.snapshot?.waypointCount).toBe(3);
    expect(state.snapshot?.plannedAltitudeM).toBe(30);
    expect(isActive(state)).toBe(true);
  });

  it('ignores start when already running', () => {
    const running = startState();
    const same = simulationReducer(running, {
      type: 'start', snapshot: { name: 'X', waypointCount: 1, plannedAltitudeM: 10 },
    });
    expect(same).toBe(running);
  });

  it('blocks a running simulation', () => {
    const state = holdState();
    expect(state.phase).toBe('holding');
    expect(state.blocked).toBe(true);
    expect(state.advisory).toBe(true);
    expect(state.events.map((e) => e.label)).toEqual([
      'Simulation started',
      'Next segment blocked',
      'Autopilot commanded hold',
      'Telemetry confirmed hold',
    ]);
  });

  it('ignores block when not running', () => {
    const ready = createSimulationState();
    expect(simulationReducer(ready, { type: 'block' })).toBe(ready);
  });

  it('ignores block when already holding', () => {
    const holding = holdState();
    expect(simulationReducer(holding, { type: 'block' })).toBe(holding);
  });

  it('clears a blockage', () => {
    const holding = holdState();
    const cleared = simulationReducer(holding, { type: 'clear' });
    expect(cleared.blocked).toBe(false);
    expect(cleared.phase).toBe('holding'); // still holding after clear
    expect(cleared.events[cleared.events.length - 1]!.label).toBe('Blockage cleared');
  });

  it('ignores clear when not blocked', () => {
    const running = startState();
    expect(simulationReducer(running, { type: 'clear' })).toBe(running);
  });

  it('holds survives clear — resume requires explicit action', () => {
    const cleared = clearedHoldState();
    expect(cleared.phase).toBe('holding');
    expect(cleared.blocked).toBe(false);
    expect(canResume(cleared)).toBe(true);
  });

  it('resumes after clear and fresh telemetry', () => {
    const cleared = clearedHoldState();
    const resumed = simulationReducer(cleared, { type: 'resume' });
    expect(resumed.phase).toBe('running');
    expect(resumed.progress).toBe(1.2);
    expect(resumed.events[resumed.events.length - 1]!.label).toBe('Operator resumed the route');
  });

  it('blocks resume when still blocked', () => {
    const holding = holdState();
    expect(canResume(holding)).toBe(false);
    expect(simulationReducer(holding, { type: 'resume' })).toBe(holding);
  });

  it('blocks resume when telemetry is stale', () => {
    const cleared = clearedHoldState();
    const stale = simulationReducer(cleared, { type: 'toggle-telemetry' });
    expect(stale.fresh).toBe(false);
    expect(canResume(stale)).toBe(false);
    expect(simulationReducer(stale, { type: 'resume' })).toBe(stale);
  });

  it('resume requires clear AND fresh telemetry', () => {
    // Block, then drop telemetry, then clear, then try resume — should fail (stale)
    const holding = holdState();
    const stale = simulationReducer(holding, { type: 'toggle-telemetry' });
    const clearedButStale = simulationReducer(stale, { type: 'clear' });
    expect(clearedButStale.fresh).toBe(false);
    expect(clearedButStale.blocked).toBe(false);
    expect(canResume(clearedButStale)).toBe(false);

    // Now restore telemetry — resume should work
    const restored = simulationReducer(clearedButStale, { type: 'toggle-telemetry' });
    expect(canResume(restored)).toBe(true);
    expect(simulationReducer(restored, { type: 'resume' }).phase).toBe('running');
  });

  it('drops and restores telemetry', () => {
    const running = startState();
    const dropped = simulationReducer(running, { type: 'toggle-telemetry' });
    expect(dropped.fresh).toBe(false);
    expect(dropped.events[dropped.events.length - 1]!.label).toBe('Telemetry unavailable');

    const restored = simulationReducer(dropped, { type: 'toggle-telemetry' });
    expect(restored.fresh).toBe(true);
    expect(restored.events[restored.events.length - 1]!.label).toBe('Telemetry restored');
  });

  it('ignores telemetry toggle when not active', () => {
    const ready = createSimulationState();
    expect(simulationReducer(ready, { type: 'toggle-telemetry' })).toBe(ready);
  });

  it('ends a simulation and retains snapshot and event history', () => {
    const running = startState();
    const ended = simulationReducer(running, { type: 'end' });
    expect(ended.phase).toBe('ended');
    expect(ended.events.map((e) => e.label)).toEqual(['Simulation started', 'Simulation ended']);
    expect(ended.snapshot?.name).toBe('Survey');
    expect(isActive(ended)).toBe(false);
  });

  it('can start again after ending with fresh events and new snapshot', () => {
    const ended = simulationReducer(startState(), { type: 'end' });
    const restarted = simulationReducer(ended, {
      type: 'start', snapshot: { name: 'New route', waypointCount: 5, plannedAltitudeM: 50 },
    });
    expect(restarted.phase).toBe('running');
    expect(restarted.snapshot?.name).toBe('New route');
    expect(restarted.events.map((e) => e.label)).toEqual(['Simulation started']);
  });

  it('ignores end when not active', () => {
    const ready = createSimulationState();
    expect(simulationReducer(ready, { type: 'end' })).toBe(ready);
  });
});

describe('simulation control guards', () => {
  it('canBlock only when running, fresh, and progress < 1', () => {
    expect(canBlock(startState())).toBe(true);
    expect(canBlock(holdState())).toBe(false);
    expect(canBlock(createSimulationState())).toBe(false);

    // After resume, progress is 1.2 — no block
    const resumed = simulationReducer(clearedHoldState(), { type: 'resume' });
    expect(canBlock(resumed)).toBe(false);
  });

  it('canClear only when blocked', () => {
    expect(canClear(holdState())).toBe(true);
    expect(canClear(startState())).toBe(false);
  });
});

describe('simulation display helpers', () => {
  it('shows correct status labels', () => {
    expect(statusLabel(startState())).toBe('Running');
    expect(statusLabel(holdState())).toBe('Holding');

    const stale = simulationReducer(startState(), { type: 'toggle-telemetry' });
    expect(statusLabel(stale)).toBe('Telemetry unavailable');
  });

  it('shows correct status notes', () => {
    expect(statusNote(startState())).toBe('Following the planned route.');
    expect(statusNote(holdState())).toContain('Segment still blocked.');

    const cleared = clearedHoldState();
    expect(statusNote(cleared)).toContain('Waiting for you to resume.');

    const stale = simulationReducer(startState(), { type: 'toggle-telemetry' });
    expect(statusNote(stale)).toContain('Resume requires fresh telemetry.');
  });

  it('shows legend text', () => {
    expect(legendText(createSimulationState(), 3)).toBe('Planned route · 3 waypoints');
    expect(legendText(startState(), 3)).toContain('Simulated drone');
    expect(legendText(holdState(), 3, 'WP 2 to WP 3')).toContain('Blocked segment');

    const stale = simulationReducer(startState(), { type: 'toggle-telemetry' });
    expect(legendText(stale, 3)).toContain('Last known position');
  });
});
