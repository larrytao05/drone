'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { DraftAnalysis } from './mission-input';
import type { MissionDraft } from './editor';
import type { MapGeometry } from './map-geometry';
import { RoutePreview } from './RoutePreview';
import styles from './Editor.module.css';

export type ReviewDialogProps = Readonly<{
  draft: MissionDraft;
  analysis: DraftAnalysis;
  geometry: MapGeometry;
  reviewed: boolean;
  error: string | null;
  onReviewedChange: (reviewed: boolean) => void;
  onConfirm: () => 'close' | 'keep-open';
  onDismiss: () => void;
}>;

export function ReviewDialog({
  draft,
  analysis,
  geometry,
  reviewed,
  error,
  onReviewedChange,
  onConfirm,
  onDismiss,
}: ReviewDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, []);

  function closeDialog() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.close();
  }

  function confirm() {
    if (onConfirm() === 'close') closeDialog();
  }

  function containTabFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;

    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      aria-labelledby="review-dialog-title"
      className={styles.reviewDialog}
      onKeyDown={containTabFocus}
      onClose={onDismiss}
      ref={dialogRef}
    >
      <div className={styles.reviewDialogBody}>
        <header className={styles.reviewDialogHeader}>
          <div>
            <span className={styles.eyebrow}>Save route</span>
            <h2 id="review-dialog-title">Review and save</h2>
          </div>
          <button aria-label="Close review" className={styles.dialogClose} onClick={closeDialog} type="button">×</button>
        </header>
        <dl className={styles.reviewSummary}>
          <div>
            <dt>Route name</dt>
            <dd>{draft.name || 'Untitled route'}</dd>
          </div>
          <div>
            <dt>Takeoff</dt>
            <dd>{draft.takeoff ? `${draft.takeoff.latitude}, ${draft.takeoff.longitude}` : 'Not set'}</dd>
          </div>
        </dl>
        <RoutePreview analysis={analysis} draft={draft} geometry={geometry} />
        {analysis.takeoffIssues.length > 0 && (
          <section aria-label="Takeoff requirements" className={styles.takeoffIssues}>
            <ul>
              {analysis.takeoffIssues.map((issue, index) => <li key={index}>Takeoff: {issue.message}</li>)}
            </ul>
          </section>
        )}
        <label className={styles.reviewChoice}>
          <input
            checked={reviewed}
            disabled={!analysis.reviewEligible}
            onChange={(event) => onReviewedChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Mark as reviewed</span>
        </label>
        {error !== null && <p className={styles.dialogError} role="alert">{error}</p>}
        <footer className={styles.reviewDialogActions}>
          <button className={styles.secondaryButton} onClick={closeDialog} type="button">Cancel</button>
          <button className={styles.quietButton} onClick={confirm} type="button">Confirm</button>
        </footer>
      </div>
    </dialog>
  );
}
