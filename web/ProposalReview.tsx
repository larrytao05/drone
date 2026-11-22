import { useMemo } from 'react';
import type { Dispatch } from 'react';
import type { EditorSession, EditorSessionAction } from './editor-session';
import { inspectProposal } from './editor-session';
import { analyseDraft } from './mission-input';
import styles from './Editor.module.css';

type ProposalReviewProps = Readonly<{
  session: EditorSession;
  dispatch: Dispatch<EditorSessionAction>;
}>;

export function ProposalReview({ session, dispatch }: ProposalReviewProps) {
  const proposal = session.proposal;
  const inspection = inspectProposal(session);
  const current = useMemo(() => analyseDraft(session.editor.draft), [session.editor.draft]);
  if (proposal === null || inspection.kind === 'none') return null;

  const ready = inspection.kind === 'ready' && current.route.kind === 'calculated' ? inspection : null;
  const stale = inspection.kind === 'stale' || ready === null;
  const noOp = ready?.numericNoOp ?? false;
  const requestId = proposal.response.requestId;
  const message = stale
    ? 'This proposal is out of date. Ask for a new proposal before applying it.'
    : noOp
      ? 'The proposed height already matches this route. Applying will close the review and preserve the current formatting.'
      : 'Review the calculated height and camera pitch changes before applying.';

  return (
    <section className={styles.proposalReview} aria-labelledby="proposal-review-title" aria-describedby="proposal-review-status">
      <div className={styles.proposalHeading}>
        <div>
          <span className={styles.eyebrow}>Proposed change</span>
          <h2 id="proposal-review-title">Review height change</h2>
        </div>
        <span className={styles.proposalState}>{stale ? 'Stale' : noOp ? 'No change' : 'Ready to review'}</span>
      </div>
      <p id="proposal-review-status" className={styles.previewDescription} role="status">{message}</p>
      {ready !== null && (
        <>
          <p className={styles.previewDescription}>
            Waypoint positions stay the same; this height-only change affects altitude and calculated camera pitch.
          </p>
          <div className={styles.previewTableScroll} role="region" aria-label="Scroll waypoint comparison horizontally" tabIndex={0}>
            <table className={styles.previewTable} aria-label="Waypoint height and camera pitch comparison">
              <thead>
                <tr>
                  <th scope="col">Waypoint</th>
                  <th scope="col">Height before (m)</th>
                  <th scope="col">Height after (m)</th>
                  <th scope="col">Pitch before (°)</th>
                  <th scope="col">Pitch after (°)</th>
                </tr>
              </thead>
              <tbody>
                {current.route.kind === 'calculated' && current.route.waypoints.map((waypoint, index) => {
                  const after = ready.preview.candidate.waypoints[index];
                  if (after === undefined) return null;
                  return (
                    <tr key={session.editor.draft.points[index]?.id ?? index}>
                      <td>{String(index + 1).padStart(2, '0')}</td>
                      <td>{String(waypoint.heightAboveTakeoffM)}</td>
                      <td>{String(after.heightAboveTakeoffM)}</td>
                      <td>{String(waypoint.gimbalPitchDeg)}</td>
                      <td>{String(after.gimbalPitchDeg)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className={styles.proposalActions}>
        <button type="button" className={styles.quietButton} onClick={() => dispatch({ type: 'dismiss-proposal', requestId })}>Dismiss</button>
        <button type="button" className={styles.secondaryButton} disabled={stale} onClick={() => dispatch({ type: 'apply-proposal', requestId })}>Apply proposed change</button>
      </div>
    </section>
  );
}
