'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { analyseDraft } from './mission-input';
import { createEditorState, editorReducer, isSaved } from './editor';
import { decodeBackup, encodeBackup, readLocalDraft, writeLocalDraft } from './draft-storage';
import { buildMapGeometry } from './map-geometry';
import type { LocalReadResult } from './draft-storage';
import type { MissionDraft } from './editor';
import type { DraftAnalysis } from './mission-input';
import type { MapGeometry } from './map-geometry';
import type { MapSourceAction, MapSourceView } from './map-source';
import { Inspector } from './Inspector';
import { ReviewDialog } from './ReviewDialog';
import { RoutePreview } from './RoutePreview';
import { MissionMap } from './MissionMap';
import styles from './Editor.module.css';

type DraftSlotStatus = LocalReadResult['kind'] | 'checking';
type SaveTransaction = Readonly<{
  draft: MissionDraft;
  revision: number;
  analysis: DraftAnalysis;
  geometry: MapGeometry;
  reviewed: boolean;
  error: string | null;
}>;

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

export function MissionEditor() {
  const [state, dispatch] = useReducer(editorReducer, undefined, createEditorState);
  const [slotStatus, setSlotStatus] = useState<DraftSlotStatus>('checking');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveTransaction, setSaveTransaction] = useState<SaveTransaction | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const currentRevision = useRef(state.revision);
  const saveInProgress = useRef(false);
  currentRevision.current = state.revision;
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
  }), [geometry.points, geometry.takeoff, geometry.target, state.draft.points, state.revision, state.selectedPointId, state.tool]);

  useEffect(() => {
    setSlotStatus(readBrowserDraft().kind);
  }, []);

  function loadDraft() {
    const result = readBrowserDraft();
    setSlotStatus(result.kind);
    if (result.kind !== 'success') {
      setLoadError(loadErrorText(result));
      return;
    }
    setLoadError(null);
    dispatch({ type: 'load-draft', draft: result.draft, reviewed: result.reviewed });
  }

  async function importBackup(file: File | undefined) {
    if (!file) return;
    const request = ++importRequest.current;
    const revision = state.revision;
    setImportError(null);
    try {
      const text = await file.text();
      if (request !== importRequest.current || revision !== currentRevision.current) return;
      const result = decodeBackup(text);
      if (!result.ok) {
        setImportError(`The backup is invalid and was not imported: ${result.issues[0]?.message ?? 'Check the backup file.'}`);
        return;
      }
      dispatch({ type: 'import-draft', draft: result.value });
    } catch {
      if (request === importRequest.current && revision === currentRevision.current) {
        setImportError('The backup file could not be read and was not imported.');
      }
    }
  }

  function startNew() {
    importRequest.current += 1;
    dispatch({ type: 'new' });
  }

  function exportBackup() {
    const url = URL.createObjectURL(new Blob([encodeBackup(state.draft)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mission-backup.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSave() {
    if (saveTransaction !== null) return;
    saveInProgress.current = false;
    setSaveTransaction({
      draft: state.draft,
      revision: state.revision,
      analysis,
      geometry,
      reviewed: state.review.kind === 'reviewed',
      error: null,
    });
  }

  function confirmSave(): 'close' | 'keep-open' {
    const transaction = saveTransaction;
    if (transaction === null || saveInProgress.current) return 'keep-open';

    if (transaction.revision !== state.revision) {
      setSaveTransaction({
        draft: state.draft,
        revision: state.revision,
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
            onChange={(event) => dispatch({ type: 'set-name', value: event.currentTarget.value })}
            placeholder="Untitled route"
            value={state.draft.name}
          />
        </label>
        <div className={styles.topActions}>
          <div className={styles.statuses}>
            <span aria-label="Review status" className={styles.statusPill} role="status">
              <span className={styles.statusDot} />
              {state.review.kind === 'reviewed' ? 'Reviewed' : 'Not reviewed'}
            </span>
            <span aria-label="Save status" className={styles.statusText} role="status">
              {isSaved(state) ? 'Saved' : 'Unsaved'}
            </span>
          </div>
          <button className={styles.secondaryButton} onClick={startNew} type="button">New</button>
          <button className={styles.quietButton} onClick={openSave} type="button">Save</button>
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.mapColumn}>
          <div className={styles.toolBar} role="group" aria-label="Map tools">
            {tools.map((tool) => (
              <button
                aria-pressed={state.tool === tool.value}
                className={state.tool === tool.value ? styles.toolActive : styles.toolButton}
                disabled={tool.value === 'set-target' && state.draft.framing.kind !== 'face-target'}
                key={tool.value}
                onClick={() => dispatch({ type: 'set-tool', tool: tool.value })}
                type="button"
              >
                {tool.label}
              </button>
            ))}
          </div>
          <MissionMap
            geometry={geometry}
            onSourceAction={(action: MapSourceAction) => dispatch(action)}
            sourceView={sourceView}
          />
          <RoutePreview analysis={analysis} draft={state.draft} geometry={geometry} />
        </section>

        <Inspector analysis={analysis} dispatch={dispatch} state={state} />
      </div>

      <footer className={styles.footer}>
        <div className={styles.storageStatus}>
          <span>Local draft</span>
          <span aria-label="Draft storage status" role="status">{slotStatusText(slotStatus)}</span>
        </div>
        <div className={styles.futureActions}>
          <button onClick={loadDraft} type="button">Load</button>
          <button onClick={() => importInput.current?.click()} type="button">Import backup</button>
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
