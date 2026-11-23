'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { analyseDraft } from './mission-input';
import { isSaved } from './editor';
import { captureAgentRequest, createEditorSession, editorSessionReducer, prepareAgentRequest } from './editor-session';
import { createAgentClient } from './agent-client';
import { decodeBackup, encodeBackup, readLocalDraft, writeLocalDraft } from './draft-storage';
import { buildMapGeometry } from './map-geometry';
import { isActive, isSimulationEditLocked, simulationBannerText } from './simulation';
import { createSimulationClient, validateEditorRouteForSimulation } from './simulation-client';
import type { LocalReadResult } from './draft-storage';
import type { MissionDraft } from './editor';
import type { EditorSessionAction, OrdinaryEditorAction } from './editor-session';
import type { DraftAnalysis } from './mission-input';
import type { MapGeometry } from './map-geometry';
import type { MapSourceAction, MapSourceView } from './map-source';
import type { MapSimulationView } from './map-simulation';
import type { RouteSnapshot, RouteSummary, SimulationAction } from './simulation';
import { Inspector } from './Inspector';
import { ReviewDialog } from './ReviewDialog';
import { RoutePreview } from './RoutePreview';
import { MissionMap } from './MissionMap';
import type { Coordinate } from '@drone/mission-planner';
import { MissionChat } from './MissionChat';
import { ProposalReview } from './ProposalReview';
import { SimulationPanel } from './SimulationPanel';
import { SimulationOverlay } from './SimulationOverlay';
import { DemoControls } from './DemoControls';
import styles from './Editor.module.css';

type DraftSlotStatus = LocalReadResult['kind'] | 'checking';
type SaveTransaction = Readonly<{
  draft: MissionDraft;
  missionBranchId: string;
  revision: number;
  analysis: DraftAnalysis;
  geometry: MapGeometry;
  reviewed: boolean;
  error: string | null;
}>;

export type EditorTab = 'edit' | 'simulation';

const tools = [
  { value: 'select', label: 'Select' },
  { value: 'add-points', label: 'Add points' },
  { value: 'set-takeoff', label: 'Set takeoff' },
  { value: 'set-target', label: 'Set target' },
] as const;

function readBrowserDraft(): LocalReadResult {
  try {
    return readLocalDraft(window.localStorage);
  } catch (error) {
    return {
      kind: 'inaccessible',
      message: error instanceof DOMException || error instanceof Error
        ? error.message
        : 'Local storage is unavailable.',
    };
  }
}

function slotStatusText(status: DraftSlotStatus): string {
  switch (status) {
    case 'checking': return 'Checking for a saved draft';
    case 'absent': return 'No saved draft';
    case 'invalid': return 'Saved draft is invalid';
    case 'inaccessible': return 'Saved draft is inaccessible';
    case 'success': return 'Saved draft available';
  }
}

function loadErrorText(result: Exclude<LocalReadResult, { kind: 'success' }>): string {
  switch (result.kind) {
    case 'absent': return 'No saved draft is available to load.';
    case 'invalid': return `The saved draft is invalid and was not loaded: ${result.issues[0]?.message ?? 'Check the saved data.'}`;
    case 'inaccessible': return `The saved draft could not be accessed: ${result.message}`;
  }
}

function saveFailureMessage(error: unknown): string {
  return error instanceof DOMException || error instanceof Error
    ? error.message
    : 'Local storage is unavailable.';
}

function isBlockedDuringSimulation(action: EditorSessionAction): boolean {
  if (action.type === 'edit') {
    return action.action.type !== 'select-point';
  }
  return action.type === 'new-route'
    || action.type === 'import-route'
    || action.type === 'load-route'
    || action.type === 'apply-proposal'
    || action.type === 'register-request'
    || action.type === 'begin-request'
    || action.type === 'receive-response';
}

export function MissionEditor() {
  const [client] = useState(() => createAgentClient());
  const [session, setSession] = useState(() => createEditorSession(globalThis.crypto.randomUUID()));
  const currentSession = useRef(session);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const agent = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const sessionDispatch = useCallback((action: EditorSessionAction) => {
    if (isSimulationEditLocked(simulationRef.current) && isBlockedDuringSimulation(action)) {
      return;
    }
    const previous = currentSession.current;
    const next = editorSessionReducer(previous, action);
    if (next === previous) return;
    currentSession.current = next;
    setSession(next);
    if (action.type === 'reset-agent') setCaptureError(null);
    if (previous.missionBranchId !== next.missionBranchId) {
      setCaptureError(null);
      const checking = client.getState().session.kind === 'loading' || client.getState().session.kind === 'unknown';
      client.reset();
      if (checking) void client.session({ action: 'status' });
      return;
    }
    if (action.type === 'cancel-request'
      || (next.request.kind === 'idle' && (previous.request.kind === 'hashing' || previous.request.kind === 'awaiting'))) {
      client.cancel();
    }
  }, [client]);
  const state = session.editor;
  const dispatch = (action: OrdinaryEditorAction) => sessionDispatch({ type: 'edit', action });

  // ---- Simulation state ----
  const [tab, setTab] = useState<EditorTab>('edit');
  const [simClient] = useState(() => createSimulationClient());
  const simulation = useSyncExternalStore(simClient.subscribe, simClient.getState, simClient.getState);
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;
  const [simValidationError, setSimValidationError] = useState<string | null>(null);

  const simActive = isSimulationEditLocked(simulation);

  useEffect(() => {
    void simClient.discover();
    return () => {
      simClient.dispose();
    };
  }, [simClient]);

  const handleSimAction = useCallback((action: SimulationAction) => {
    if (simClient.isBridgeAvailable() && simulation.mode === 'live') {
      if (action.type === 'resume') {
        void simClient.resume();
      } else if (action.type === 'end') {
        void simClient.end();
      }
    } else {
      simClient.dispatchFixture(action);
    }
  }, [simClient, simulation.mode]);

  // Wire start to capture immutable route snapshot
  const handleStart = useCallback(async () => {
    client.cancel();
    sessionDispatch({ type: 'reset-agent' });
    importRequest.current += 1;
    setImportFocus(null);
    setSaveTransaction(null);
    setSimValidationError(null);

    const sess = currentSession.current;
    const currentAnalysis = analyseDraft(sess.editor.draft);
    const name = sess.editor.draft.name || 'Untitled route';
    const waypointCount = sess.editor.draft.points.length;
    const altitude = currentAnalysis.route.kind === 'calculated'
      ? currentAnalysis.route.input.heightAboveTakeoffM
      : Number(sess.editor.draft.height) || 0;
    const currentGeometry = buildMapGeometry({
      sourcePoints: currentAnalysis.sourcePoints,
      route: currentAnalysis.route,
      takeoff: currentAnalysis.takeoff,
      target: currentAnalysis.target,
    });
    const snapshot: RouteSnapshot = {
      name,
      waypointCount,
      plannedAltitudeM: altitude,
      geometry: currentGeometry,
    };

    if (simClient.isBridgeAvailable()) {
      const validation = validateEditorRouteForSimulation(sess.editor.draft, currentAnalysis);
      if (!validation.ok) {
        setSimValidationError(validation.error);
        return;
      }
      await simClient.start(snapshot, validation.route);
      setTab('simulation');
    } else {
      simClient.dispatchFixture({ type: 'start', snapshot });
      setTab('simulation');
    }
  }, [client, sessionDispatch, simClient]);

  // ---- Existing editor state ----
  const [slotStatus, setSlotStatus] = useState<DraftSlotStatus>('checking');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveTransaction, setSaveTransaction] = useState<SaveTransaction | null>(null);
  const [importFocus, setImportFocus] = useState<Coordinate | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const consumeImportFocus = useCallback((focus: Coordinate) => {
    setImportFocus((pending) => pending === focus ? null : pending);
  }, []);
  const saveInProgress = useRef(false);
  const analysis = useMemo(() => analyseDraft(state.draft), [state.draft]);
  const geometry = useMemo(() => buildMapGeometry({
    sourcePoints: analysis.sourcePoints,
    route: analysis.route,
    takeoff: analysis.takeoff,
    target: analysis.target,
  }), [analysis]);
  const sourceView = useMemo<MapSourceView>(() => ({
    points: geometry.points,
    sourcePointIds: state.draft.points.map((point) => point.id),
    selectedPointId: state.selectedPointId,
    tool: state.tool,
    revision: state.revision,
    takeoff: geometry.takeoff,
    target: geometry.target,
    dragDisabled: simActive,
  }), [geometry.points, geometry.takeoff, geometry.target, simActive, state.draft.points, state.revision, state.selectedPointId, state.tool]);

  const draftSummary = useMemo<RouteSummary>(() => {
    const altitude = analysis.route.kind === 'calculated'
      ? analysis.route.input.heightAboveTakeoffM
      : Number(state.draft.height) || 0;
    return {
      name: state.draft.name || 'Untitled route',
      waypointCount: state.draft.points.length,
      plannedAltitudeM: altitude,
    };
  }, [analysis.route, state.draft.height, state.draft.name, state.draft.points.length]);

  const simulationView = useMemo<MapSimulationView | null>(() => {
    if (tab !== 'simulation' && !simActive) return null;
    const activeRouteGeometry = simActive && simulation.snapshot?.geometry
      ? simulation.snapshot.geometry
      : geometry;
    return {
      simulation,
      geometry: activeRouteGeometry,
    };
  }, [tab, simActive, simulation, geometry]);

  useEffect(() => {
    setSlotStatus(readBrowserDraft().kind);
  }, []);

  useEffect(() => {
    let authenticated = client.getState().session.kind === 'authenticated';
    const unsubscribe = client.subscribe(() => {
      const nextAuthenticated = client.getState().session.kind === 'authenticated';
      const expired = authenticated && !nextAuthenticated;
      authenticated = nextAuthenticated;
      if (expired) sessionDispatch({ type: 'reset-agent' });
    });
    void client.session({ action: 'status' });
    return () => { unsubscribe(); client.reset(); };
  }, [client, sessionDispatch]);

  function cancelRequest(requestId: string) {
    sessionDispatch({ type: 'cancel-request', requestId });
  }

  function sendMessage(message: string): boolean {
    if (isSimulationEditLocked(simulationRef.current)) return false;
    const requestId = client.createRequestId();
    if (requestId === null) return false;
    const captured = captureAgentRequest(currentSession.current, {
      requestId, message, history: [...client.getState().history],
    });
    if (captured.kind !== 'ready') {
      client.cancel();
      setCaptureError(captured.kind === 'invalid-draft'
        ? 'Complete the route settings and waypoint coordinates before sending.'
        : 'Enter a shorter message or start a new conversation.');
      return false;
    }
    setCaptureError(null);
    sessionDispatch({ type: 'register-request', capture: captured.capture });
    void (async () => {
      try {
        const request = await prepareAgentRequest(captured.capture, () => currentSession.current);
        if (request === null) {
          const pending = currentSession.current.request;
          if (pending.kind === 'hashing' && pending.capture.requestId === requestId) {
            cancelRequest(requestId);
            setCaptureError('The request is incomplete or too large. Try a shorter message.');
          }
          return;
        }
        sessionDispatch({ type: 'begin-request', capture: captured.capture, request });
        const pending = currentSession.current.request;
        if (pending.kind !== 'awaiting' || pending.capture !== captured.capture) return;
        const response = await client.send(request);
        if (response !== null) receiveResponse(response);
      } catch {
        const pending = currentSession.current.request;
        if ((pending.kind !== 'hashing' && pending.kind !== 'awaiting') || pending.capture.requestId !== requestId) return;
        cancelRequest(requestId);
        setCaptureError('The route could not be prepared. Try sending again.');
      }
    })();
    return true;
  }

  function receiveResponse(response: NonNullable<Awaited<ReturnType<typeof client.send>>>) {
    sessionDispatch({ type: 'receive-response', response });
    const current = currentSession.current;
    if (!isSimulationEditLocked(simulationRef.current)
      && response.outcome.kind === 'proposed'
      && current.request.kind === 'finished'
      && current.request.requestId === response.requestId
      && current.proposal === null) {
      setCaptureError('The proposed change cannot be applied to this route. Ask for a valid height change.');
    }
  }

  async function retryRequest() {
    const response = await client.retry();
    if (response !== null) receiveResponse(response);
  }

  function changeAuthentication(action: Parameters<typeof client.session>[0]) {
    sessionDispatch({ type: 'reset-agent' });
    void client.session(action).catch(() => {
      setCaptureError('Sign-in could not be prepared. Check the password and try again.');
    });
  }

  function loadDraft() {
    if (isSimulationEditLocked(simulationRef.current)) return;
    importRequest.current += 1;
    setImportFocus(null);
    const result = readBrowserDraft();
    setSlotStatus(result.kind);
    if (result.kind !== 'success') {
      setLoadError(loadErrorText(result));
      return;
    }
    setLoadError(null);
    sessionDispatch({ type: 'load-route', missionBranchId: globalThis.crypto.randomUUID(), draft: result.draft, reviewed: result.reviewed });
  }

  async function importBackup(file: File | undefined) {
    if (!file || isSimulationEditLocked(simulationRef.current)) return;
    const request = ++importRequest.current;
    const revision = currentSession.current.editor.revision;
    const missionBranchId = currentSession.current.missionBranchId;
    setImportError(null);
    try {
      const text = await file.text();
      if (request !== importRequest.current || revision !== currentSession.current.editor.revision
        || missionBranchId !== currentSession.current.missionBranchId
        || isSimulationEditLocked(simulationRef.current)) return;
      const result = decodeBackup(text);
      if (!result.ok) {
        setImportError(`The backup is invalid and was not imported: ${result.issues[0]?.message ?? 'Check the backup file.'}`);
        return;
      }
      sessionDispatch({ type: 'import-route', missionBranchId: globalThis.crypto.randomUUID(), draft: result.value });
      setImportFocus(analyseDraft(result.value).sourcePoints[0]?.coordinate ?? null);
    } catch {
      if (request === importRequest.current && revision === currentSession.current.editor.revision
        && missionBranchId === currentSession.current.missionBranchId
        && !isSimulationEditLocked(simulationRef.current)) {
        setImportError('The backup file could not be read and was not imported.');
      }
    }
  }

  function startNew() {
    if (isSimulationEditLocked(simulationRef.current)) return;
    importRequest.current += 1;
    setImportFocus(null);
    sessionDispatch({ type: 'new-route', missionBranchId: globalThis.crypto.randomUUID() });
  }

  function exportBackup() {
    const url = URL.createObjectURL(new Blob([encodeBackup(currentSession.current.editor.draft)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mission-backup.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSave() {
    if (saveTransaction !== null || isSimulationEditLocked(simulationRef.current)) return;
    saveInProgress.current = false;
    const current = currentSession.current;
    const analysis = analyseDraft(current.editor.draft);
    const geometry = buildMapGeometry({ sourcePoints: analysis.sourcePoints, route: analysis.route, takeoff: analysis.takeoff, target: analysis.target });
    setSaveTransaction({
      draft: current.editor.draft,
      missionBranchId: current.missionBranchId,
      revision: current.editor.revision,
      analysis,
      geometry,
      reviewed: current.editor.review.kind === 'reviewed',
      error: null,
    });
  }

  function confirmSave(): 'close' | 'keep-open' {
    const transaction = saveTransaction;
    if (transaction === null || saveInProgress.current || isSimulationEditLocked(simulationRef.current)) return 'keep-open';

    const current = currentSession.current;
    if (transaction.revision !== current.editor.revision || transaction.missionBranchId !== current.missionBranchId) {
      const analysis = analyseDraft(current.editor.draft);
      const geometry = buildMapGeometry({ sourcePoints: analysis.sourcePoints, route: analysis.route, takeoff: analysis.takeoff, target: analysis.target });
      setSaveTransaction({
        draft: current.editor.draft,
        missionBranchId: current.missionBranchId,
        revision: current.editor.revision,
        analysis,
        geometry,
        reviewed: false,
        error: 'The route changed while review was open. Review the refreshed source before saving.',
      });
      return 'keep-open';
    }

    if (transaction.reviewed && !transaction.analysis.reviewEligible) {
      setSaveTransaction({ ...transaction, error: 'This route is not ready to be marked as reviewed.' });
      return 'keep-open';
    }

    saveInProgress.current = true;
    let result;
    try {
      result = writeLocalDraft({
        storage: window.localStorage,
        draft: transaction.draft,
        reviewed: transaction.reviewed,
      });
    } catch (error) {
      result = { kind: 'failure' as const, message: saveFailureMessage(error) };
    }

    if (result.kind === 'failure') {
      saveInProgress.current = false;
      setSaveTransaction({ ...transaction, error: `The draft was not saved: ${result.message}` });
      return 'keep-open';
    }

    dispatch({ type: 'save-succeeded', revision: transaction.revision, reviewed: transaction.reviewed });
    setSlotStatus('success');
    return 'close';
  }

  function dismissSave() {
    setSaveTransaction(null);
  }

  return (
    <main className={styles.editor}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/" aria-label="Drone mission planner home">
          <span className={styles.brandMark} aria-hidden="true">D</span>
          <h1 className={styles.brandTitle}>Mission planner</h1>
        </a>
        <label className={styles.routeName}>
          <span>Route name</span>
          <input
            aria-label="Route name"
            disabled={simActive}
            onChange={(event) => dispatch({ type: 'set-name', value: event.currentTarget.value })}
            placeholder="Untitled route"
            value={state.draft.name}
          />
        </label>
        <div className={styles.topActions}>
          <nav className={styles.editorTabs} aria-label="Editor view">
            <button
              aria-pressed={tab === 'edit'}
              className={tab === 'edit' ? styles.tabActive : styles.tabButton}
              onClick={() => setTab('edit')}
              type="button"
            >
              Edit
            </button>
            <button
              aria-pressed={tab === 'simulation'}
              className={tab === 'simulation' ? styles.tabActive : styles.tabButton}
              onClick={() => setTab('simulation')}
              type="button"
            >
              Simulation
            </button>
          </nav>
          <div className={styles.statuses}>
            <span aria-label="Review status" className={styles.statusPill} role="status">
              <span className={styles.statusDot} />
              {state.review.kind === 'reviewed' ? 'Reviewed' : 'Not reviewed'}
            </span>
            <span aria-label="Save status" className={styles.statusText} role="status">
              {isSaved(state) ? 'Saved' : 'Unsaved'}
            </span>
          </div>
          <button className={styles.secondaryButton} disabled={simActive} onClick={startNew} type="button">New</button>
          <button className={styles.quietButton} disabled={simActive} onClick={openSave} type="button">Save</button>
        </div>
      </header>

      {/* Banner shown on Edit tab during active simulation */}
      {tab === 'edit' && simActive && (
        <div className={styles.simBanner} role="status">
          {simulationBannerText(simulation)}{' '}
          <button
            className={styles.secondaryButton}
            onClick={() => setTab('simulation')}
            type="button"
          >
            Back to Simulation
          </button>
        </div>
      )}

      <div className={styles.workspace}>
        <section className={styles.mapColumn}>
          <div className={styles.toolBar} role="group" aria-label="Map tools">
            {tools.map((tool) => (
              <button
                aria-pressed={state.tool === tool.value}
                className={state.tool === tool.value ? styles.toolActive : styles.toolButton}
                disabled={simActive || (tool.value === 'set-target' && state.draft.framing.kind !== 'face-target')}
                key={tool.value}
                onClick={() => dispatch({ type: 'set-tool', tool: tool.value })}
                type="button"
              >
                {tool.label}
              </button>
            ))}
          </div>
          <div className={styles.mapContainer}>
            <MissionMap
              cameraFocus={importFocus}
              onCameraFocusHandled={consumeImportFocus}
              geometry={simActive && simulation.snapshot?.geometry ? simulation.snapshot.geometry : geometry}
              onSourceAction={(action: MapSourceAction) => dispatch(action)}
              simulationView={simulationView}
              sourceView={sourceView}
            >
              {({ status: mapStatus }) => (tab === 'simulation' || simActive) && (
                <SimulationOverlay
                  draftWaypointCount={draftSummary.waypointCount}
                  geometry={simActive && simulation.snapshot?.geometry ? simulation.snapshot.geometry : geometry}
                  mapStatus={mapStatus}
                  simulation={simulation}
                />
              )}
            </MissionMap>
          </div>
          <RoutePreview analysis={analysis} draft={state.draft} geometry={geometry} />
          <MissionChat
            key={session.missionBranchId}
            analysis={analysis}
            error={captureError}
            onCancel={() => {
              const pending = currentSession.current.request;
              if (pending.kind === 'hashing' || pending.kind === 'awaiting') cancelRequest(pending.capture.requestId);
            }}
            onRetry={() => { void retryRequest(); }}
            onReset={() => { sessionDispatch({ type: 'reset-agent' }); client.reset(); }}
            onSend={sendMessage}
            onSession={changeAuthentication}
            composeDisabled={simActive}
            pending={session.request.kind === 'hashing' || agent.turn.kind === 'loading'}
            state={agent}
          />
          <ProposalReview session={session} dispatch={sessionDispatch} disabled={simActive} />
          {/* Demo controls only visible on Simulation tab while active */}
          {tab === 'simulation' && isActive(simulation) && (
            <DemoControls simulation={simulation} onSimAction={handleSimAction} />
          )}
        </section>

        {tab === 'simulation' ? (
          <aside className={styles.inspector} aria-label="Simulation inspector" role="region">
            <SimulationPanel
              draftSummary={draftSummary}
              onSimAction={handleSimAction}
              onStart={handleStart}
              simulation={simulation}
              validationError={simValidationError}
              modeBadge={simulation.mode === 'live' || simClient.isBridgeAvailable() ? 'Isolated PX4 simulator' : undefined}
            />
          </aside>
        ) : (
          <Inspector analysis={analysis} dispatch={dispatch} state={state} disabled={simActive} />
        )}
      </div>

      <footer className={styles.footer}>
        <div className={styles.storageStatus}>
          <span>Local draft</span>
          <span aria-label="Draft storage status" role="status">{slotStatusText(slotStatus)}</span>
        </div>
        <div className={styles.futureActions}>
          <button disabled={simActive} onClick={loadDraft} type="button">Load</button>
          <button disabled={simActive} onClick={() => importInput.current?.click()} type="button">Import backup</button>
          <input
            accept="application/json,.json"
            aria-label="Import backup"
            hidden
            onChange={(event) => {
              void importBackup(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
            ref={importInput}
            type="file"
          />
          <button onClick={exportBackup} type="button">Export backup</button>
        </div>
      </footer>
      {loadError !== null && <p className={styles.loadError} role="alert">{loadError}</p>}
      {importError !== null && <p className={styles.loadError} role="alert">{importError}</p>}
      {saveTransaction !== null && (
        <ReviewDialog
          analysis={saveTransaction.analysis}
          draft={saveTransaction.draft}
          error={saveTransaction.error}
          geometry={saveTransaction.geometry}
          onConfirm={confirmSave}
          onDismiss={dismissSave}
          onReviewedChange={(reviewed) => setSaveTransaction((current) => current === null ? current : { ...current, reviewed, error: null })}
          reviewed={saveTransaction.reviewed}
        />
      )}
    </main>
  );
}
