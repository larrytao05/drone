import {
  simulationResponseSchema,
  simulationRouteInputSchema,
  type SimulationCommandRequest,
  type SimulationResponse,
  type SimulationRouteInput,
  type SimulationStatus,
} from '../src/simulation-contract';
import type { DraftAnalysis } from './mission-input';
import type { MissionDraft } from './editor';
import type { RouteSnapshot, SimulationAction, SimulationState } from './simulation';
import { createSimulationState, simulationReducer } from './simulation';
import { buildMapGeometry } from './map-geometry';

export type RouteValidationResult =
  | Readonly<{ ok: true; route: SimulationRouteInput }>
  | Readonly<{ ok: false; error: string }>;

export function validateEditorRouteForSimulation(
  draft: MissionDraft,
  analysis: DraftAnalysis,
): RouteValidationResult {
  if (analysis.route.kind !== 'calculated') {
    return {
      ok: false,
      error: 'Route must be fully calculated before starting simulation.',
    };
  }

  const plannedWaypoints = analysis.route.waypoints;
  if (!plannedWaypoints || plannedWaypoints.length < 2) {
    return {
      ok: false,
      error: 'Simulation route requires at least 2 waypoints.',
    };
  }

  const altitude = analysis.route.input.heightAboveTakeoffM;
  if (!Number.isFinite(altitude) || altitude <= 0 || altitude > 120) {
    return {
      ok: false,
      error: 'Planned altitude must be a positive number in meters (max 120m).',
    };
  }

  for (let i = 0; i < plannedWaypoints.length; i++) {
    const wp = plannedWaypoints[i];
    const lat = wp?.coordinate?.latitudeDeg;
    const lon = wp?.coordinate?.longitudeDeg;
    if (
      lat === undefined ||
      lon === undefined ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180
    ) {
      return {
        ok: false,
        error: `Waypoint ${i + 1} has an invalid geographic coordinate.`,
      };
    }
  }

  const rawRoute = {
    name: draft.name || 'Untitled route',
    plannedAltitudeM: altitude,
    waypoints: plannedWaypoints.map((wp) => ({
      latitudeDeg: wp.coordinate.latitudeDeg,
      longitudeDeg: wp.coordinate.longitudeDeg,
      altitudeM: altitude,
    })),
  };

  const parsed = simulationRouteInputSchema.safeParse(rawRoute);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid route input for simulation.',
    };
  }

  return {
    ok: true,
    route: parsed.data,
  };
}

export function buildSnapshotFromRoute(route: SimulationRouteInput): RouteSnapshot {
  const wps = route.waypoints;
  const sourcePoints = wps.map((wp, i) => ({
    id: `recovered-wp-${i + 1}`,
    coordinate: { latitudeDeg: wp.latitudeDeg, longitudeDeg: wp.longitudeDeg },
  }));
  const plannedWaypoints = wps.map((wp) => ({
    coordinate: { latitudeDeg: wp.latitudeDeg, longitudeDeg: wp.longitudeDeg },
    heightAboveTakeoffM: wp.altitudeM,
    headingDeg: 0,
    gimbalPitchDeg: 0,
  }));
  return {
    name: route.name || 'Executed route',
    waypointCount: wps.length,
    plannedAltitudeM: route.plannedAltitudeM,
    geometry: buildMapGeometry({
      sourcePoints,
      route: {
        kind: 'calculated',
        input: {
          shot: { kind: 'route', anchors: sourcePoints.map((p) => p.coordinate) },
          heightAboveTakeoffM: route.plannedAltitudeM,
          framing: { kind: 'fixed', headingDeg: 0, gimbalPitchDeg: 0 },
        },
        waypoints: plannedWaypoints,
      },
      takeoff: null,
      target: null,
    }),
  };
}

export function projectStatusToState(
  currentState: SimulationState,
  status: SimulationStatus,
): SimulationState {
  const advisory =
    currentState.advisory ||
    status.events.some((e) => e.label.toLowerCase().includes('advisory'));

  let snapshot = currentState.snapshot;
  if (!snapshot && status.route) {
    snapshot = buildSnapshotFromRoute(status.route);
  }

  return {
    ...currentState,
    mode: 'live',
    runId: status.runId,
    phase: status.phase,
    blocked: status.blocked,
    holdRequested: status.holdRequested,
    holdConfirmed: status.holdConfirmed,
    fresh: status.fresh,
    cleanupCompleted: status.cleanupCompleted,
    ownershipChecking: false,
    snapshot,
    progress: 0,
    tick: status.events.length,
    telemetry: status.telemetry
      ? {
          lat: status.telemetry.position.lat,
          lon: status.telemetry.position.lon,
          altM: status.telemetry.position.altM,
          northProgressM: status.telemetry.position.northProgressM,
          speedMs: status.telemetry.velocity.speedMs,
          timestamp: status.telemetry.timestamp,
          sampleAgeMs: status.telemetry.sampleAgeMs,
        }
      : null,
    events: status.events.map((e) => ({
      tick: e.seq,
      label: e.label,
      seq: e.seq,
      timestamp: e.timestamp,
    })),
    error: status.error,
    advisory,
  };
}

export type SimulationClientOptions = Readonly<{
  baseUrl?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
}>;

export function createSimulationClient(options: SimulationClientOptions = {}) {
  const customFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? '/api/simulation';
  const pollIntervalMs = options.pollIntervalMs ?? 400;

  const isVitest = typeof process !== 'undefined' && Boolean(process.env.VITEST);
  const isUnmockedNode =
    isVitest &&
    customFetch === globalThis.fetch &&
    !('mock' in (customFetch as unknown as Record<string, unknown>)) &&
    !baseUrl.startsWith('http://') &&
    !baseUrl.startsWith('https://');

  let state: SimulationState = {
    ...createSimulationState(),
    mode: 'fixture',
    cleanupCompleted: true,
    ownershipChecking: !isUnmockedNode,
  };

  let activeRunId: string | null = null;
  let lastAppliedSeq = -1;
  let runGeneration = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbort: AbortController | null = null;
  let isDisposed = false;
  let bridgeAvailable = false;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  function setState(next: SimulationState) {
    state = next;
    notify();
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (activeAbort !== null) {
      activeAbort.abort();
      activeAbort = null;
    }
  }

  function scheduleNextPoll() {
    if (isDisposed || pollTimer !== null || !activeRunId) return;
    if (state.cleanupCompleted === true && (state.phase === 'ended' || state.phase === 'failed')) {
      return;
    }
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void executePoll();
    }, pollIntervalMs);
  }

  function scheduleDiscoveryRetry() {
    if (isDisposed || discoveryTimer !== null) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      if (!isDisposed && state.ownershipChecking) {
        void discover();
      }
    }, pollIntervalMs);
  }

  function applyStatus(status: SimulationStatus, generation?: number) {
    if (generation !== undefined && generation !== runGeneration) return;
    if (!activeRunId || status.runId !== activeRunId) return;
    if (status.seq < lastAppliedSeq) return;
    lastAppliedSeq = status.seq;

    setState(projectStatusToState(state, status));

    if (status.cleanupCompleted === true && (status.phase === 'ended' || status.phase === 'failed')) {
      stopPolling();
    }
  }

  async function executePoll(): Promise<void> {
    if (isDisposed || !activeRunId) return;
    const pollGen = runGeneration;
    const pollRunId = activeRunId;
    activeAbort = new AbortController();
    try {
      const url = `${baseUrl}?runId=${encodeURIComponent(activeRunId)}`;
      const res = await customFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: activeAbort.signal,
      });

      if (pollGen !== runGeneration || activeRunId !== pollRunId) return;

      if (!res.ok) {
        if (res.status === 400) {
          try {
            const json = await res.json();
            const parsed = simulationResponseSchema.safeParse(json);
            if (parsed.success && !parsed.data.ok && parsed.data.error.code === 'WRONG_RUN') {
              setState({
                ...state,
                phase: 'failed',
                cleanupCompleted: false,
                fresh: false,
                error: parsed.data.error,
                events: [...state.events, { tick: state.events.length + 1, label: parsed.data.error.message }],
              });
              return;
            }
          } catch {
            // ignore
          }
        }
        setState({ ...state, fresh: false });
        return;
      }

      const json = await res.json();
      if (pollGen !== runGeneration || activeRunId !== pollRunId) return;

      const parsed = simulationResponseSchema.safeParse(json);
      if (parsed.success && parsed.data.ok) {
        applyStatus(parsed.data.status, pollGen);
      } else {
        setState({ ...state, fresh: false });
      }
    } catch {
      if (!isDisposed && pollGen === runGeneration && activeRunId === pollRunId) {
        setState({ ...state, fresh: false });
      }
    } finally {
      activeAbort = null;
      if (!isDisposed && activeRunId && (state.cleanupCompleted !== true || (state.phase !== 'ended' && state.phase !== 'failed'))) {
        scheduleNextPoll();
      }
    }
  }

  async function discover(): Promise<boolean> {
    isDisposed = false;
    if (isUnmockedNode) {
      bridgeAvailable = false;
      return false;
    }
    let res: Response;
    try {
      res = await customFetch(baseUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      // Network failure / uncertainty
      scheduleDiscoveryRetry();
      return false;
    }

    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        // Confirmed disabled: endpoint doesn't exist
        bridgeAvailable = false;
        setState({ ...state, mode: 'fixture', cleanupCompleted: true, ownershipChecking: false });
        return false;
      }
      // 5xx / 4xx server error: uncertainty
      scheduleDiscoveryRetry();
      return false;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      scheduleDiscoveryRetry();
      return false;
    }

    const parsed = simulationResponseSchema.safeParse(json);
    if (!parsed.success || !parsed.data.ok) {
      // Confirmed disabled fixture behavior (e.g. { kind: 'local' })
      bridgeAvailable = false;
      setState({ ...state, mode: 'fixture', cleanupCompleted: true, ownershipChecking: false });
      return false;
    }

    bridgeAvailable = true;
    const status = parsed.data.status;
    const isUncleaned = status.cleanupCompleted === false;
    const isLivePhase = status.phase === 'starting' || status.phase === 'running' || status.phase === 'holding' || status.phase === 'ending';

    if (status.runId && (isUncleaned || isLivePhase)) {
      runGeneration++;
      activeRunId = status.runId;
      lastAppliedSeq = status.seq;
      setState(projectStatusToState(state, status));
      scheduleNextPoll();
    } else if (status.runId && status.cleanupCompleted === true && (status.phase === 'ended' || status.phase === 'failed')) {
      setState(projectStatusToState(state, status));
    } else {
      if (state.runId && state.cleanupCompleted === false) {
        setState({
          ...state,
          phase: 'failed',
          cleanupCompleted: false,
          ownershipChecking: false,
          error: {
            code: 'WRONG_RUN',
            message: `Cleanup of run '${state.runId}' could not be confirmed (bridge reports no active run). Edit lock retained.`,
          },
        });
      } else {
        setState({
          ...state,
          mode: 'live',
          cleanupCompleted: true,
          ownershipChecking: false,
        });
      }
    }

    return true;
  }

  async function postCommand(command: SimulationCommandRequest): Promise<SimulationResponse | null> {
    try {
      const res = await customFetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      });
      const json = await res.json();
      const parsed = simulationResponseSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function reconcileStartStatus(gen: number): Promise<boolean> {
    try {
      const res = await customFetch(baseUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (gen !== runGeneration) return false;
      if (res.ok) {
        const json = await res.json();
        const parsed = simulationResponseSchema.safeParse(json);
        if (parsed.success && parsed.data.ok) {
          const status = parsed.data.status;
          if (status.runId && (status.cleanupCompleted === false || status.phase !== 'ready')) {
            activeRunId = status.runId;
            lastAppliedSeq = status.seq;
            applyStatus(status, gen);
            scheduleNextPoll();
            return true;
          } else if (status.cleanupCompleted === true && status.phase === 'ready') {
            setState({
              ...state,
              phase: 'failed',
              cleanupCompleted: true,
              error: {
                code: 'SIMULATOR_ERROR',
                message: 'Failed to start simulator: connection was lost before run started.',
              },
            });
            return false;
          }
        }
      }
    } catch {
      // Reconcile attempt failed
    }

    // Uncertain: keep cleanupCompleted: false, retry reconciliation
    if (!isDisposed && gen === runGeneration) {
      setTimeout(() => {
        if (!isDisposed && gen === runGeneration && state.cleanupCompleted === false && state.phase === 'failed') {
          void reconcileStartStatus(gen);
        }
      }, pollIntervalMs);
    }
    return false;
  }

  async function start(snapshot: RouteSnapshot, routeInput?: SimulationRouteInput): Promise<boolean> {
    isDisposed = false;
    if (!bridgeAvailable) {
      // Fallback to fixture mode
      setState(simulationReducer(state, { type: 'start', snapshot }));
      return true;
    }

    stopPolling();
    runGeneration++;
    const startGen = runGeneration;
    activeRunId = null;
    lastAppliedSeq = -1;

    const command: SimulationCommandRequest = routeInput
      ? { action: 'start', route: routeInput }
      : { action: 'start' };

    setState({
      ...state,
      phase: 'starting',
      mode: 'live',
      snapshot,
      fresh: true,
      blocked: false,
      holdRequested: false,
      holdConfirmed: false,
      cleanupCompleted: false,
      ownershipChecking: false,
      advisory: false,
      events: [{ tick: 1, label: 'Simulation run initialized' }],
      error: null,
      telemetry: null,
    });

    const response = await postCommand(command);
    if (startGen !== runGeneration) return false;

    if (response && response.ok) {
      activeRunId = response.status.runId;
      lastAppliedSeq = response.status.seq;
      applyStatus(response.status, startGen);
      scheduleNextPoll();
      return true;
    }

    if (response && !response.ok) {
      if (response.status) {
        if (response.status.cleanupCompleted === false || response.status.runId) {
          activeRunId = response.status.runId;
          lastAppliedSeq = response.status.seq;
          applyStatus(response.status, startGen);
          scheduleNextPoll();
          return false;
        }
      }
      setState({
        ...state,
        phase: 'failed',
        cleanupCompleted: true,
        error: response.error,
        events: [...state.events, { tick: state.events.length + 1, label: response.error.message }],
      });
      return false;
    }

    // response === null: Lost acknowledgement / transport failure
    setState({
      ...state,
      phase: 'failed',
      cleanupCompleted: false, // retain ownership!
      error: {
        code: 'SIMULATOR_ERROR',
        message: 'Lost connection during simulation start. Reconciling authoritative status...',
      },
    });

    return await reconcileStartStatus(startGen);
  }

  async function resume(): Promise<boolean> {
    if (!activeRunId) {
      if (state.mode === 'fixture') {
        setState(simulationReducer(state, { type: 'resume' }));
        return true;
      }
      return false;
    }

    const res = await postCommand({ action: 'resume', runId: activeRunId });
    if (res && res.ok) {
      applyStatus(res.status);
      return true;
    }
    if (res && !res.ok) {
      setState({ ...state, error: res.error });
    }
    return false;
  }

  async function reconcileEndMismatch(
    targetRunId: string,
    error?: { code: string; message: string },
  ): Promise<boolean> {
    const errorToSurface = error ?? {
      code: 'WRONG_RUN',
      message: `End command rejected: target run '${targetRunId}' does not match bridge run.`,
    };

    try {
      const res = await customFetch(baseUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const json = await res.json();
        const parsed = simulationResponseSchema.safeParse(json);
        if (parsed.success && parsed.data.ok) {
          const status = parsed.data.status;
          // ONLY adopt cleanup if the authoritative bridge status matches targetRunId AND confirms cleanup!
          // NEVER infer cleanup of targetRunId from another run or empty restarted bridge!
          if (status.runId === targetRunId && status.cleanupCompleted === true && (status.phase === 'ended' || status.phase === 'failed')) {
            applyStatus(status);
            return true;
          }
        }
      }
    } catch {
      // Reconciliation fetch failed
    }

    // If we could not confirm cleanup of targetRunId:
    // Retain ownership (cleanupCompleted: false), transition phase to failed (NOT ending), and visibly surface error.
    setState({
      ...state,
      phase: 'failed',
      cleanupCompleted: false,
      error: errorToSurface,
      events: [
        ...state.events,
        { tick: state.events.length + 1, label: errorToSurface.message },
      ],
    });
    return false;
  }

  async function end(): Promise<boolean> {
    if (!activeRunId) {
      if (state.mode === 'fixture') {
        setState(simulationReducer(state, { type: 'end' }));
        return true;
      }
      return false;
    }

    setState({ ...state, phase: 'ending' });
    const res = await postCommand({ action: 'end', runId: activeRunId });
    if (res && res.ok) {
      if (res.status.runId === activeRunId) {
        applyStatus(res.status);
        return true;
      }
      return await reconcileEndMismatch(activeRunId, {
        code: 'WRONG_RUN',
        message: `End response returned status for unexpected run '${res.status.runId}'. Cleanup of '${activeRunId}' cannot be confirmed.`,
      });
    }

    if (res && !res.ok) {
      const isMismatched =
        res.error?.code === 'WRONG_RUN' ||
        (res.status !== undefined && res.status.runId !== activeRunId);

      if (isMismatched) {
        return await reconcileEndMismatch(activeRunId, res.error);
      }

      if (res.status && res.status.runId === activeRunId) {
        applyStatus(res.status);
      } else {
        setState({
          ...state,
          phase: 'failed',
          cleanupCompleted: false,
          error: res.error,
          events: res.error
            ? [...state.events, { tick: state.events.length + 1, label: res.error.message }]
            : state.events,
        });
      }
      return false;
    }

    // res === null: network transport failure during teardown
    setState({
      ...state,
      phase: 'failed',
      cleanupCompleted: false, // retain ownership so edit lock remains and End can be retried!
      error: {
        code: 'SIMULATOR_ERROR',
        message: 'Network error during teardown. End simulation can be retried.',
      },
      events: [
        ...state.events,
        { tick: state.events.length + 1, label: 'Teardown command failed due to network error' },
      ],
    });
    return false;
  }

  function dispatchFixture(action: SimulationAction) {
    const next = simulationReducer(state, action);
    setState({
      ...next,
      mode: 'fixture',
      cleanupCompleted: true,
      ownershipChecking: false,
    });
  }

  function dispose() {
    isDisposed = true;
    if (discoveryTimer !== null) {
      clearTimeout(discoveryTimer);
      discoveryTimer = null;
    }
    stopPolling();
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    discover,
    start,
    resume,
    end,
    reconcile: (error?: { code: string; message: string }) => reconcileEndMismatch(activeRunId ?? state.runId ?? '', error),
    dispatchFixture,
    isBridgeAvailable: () => bridgeAvailable,
    dispose,
  };
}
