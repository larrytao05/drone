import { useState } from 'react';
import type { AgentClientState, AgentFailure, AgentProgressEvent, createAgentClient } from './agent-client';
import type { DraftAnalysis } from './mission-input';
import styles from './Editor.module.css';

type MissionChatProps = Readonly<{
  analysis: DraftAnalysis;
  state: AgentClientState;
  pending: boolean;
  error: string | null;
  onSend: (message: string) => boolean;
  onCancel: () => void;
  onRetry: () => void;
  onReset: () => void;
  onSession: (action: Parameters<ReturnType<typeof createAgentClient>['session']>[0]) => void;
}>;

function diagnosticMessage(diagnostic: AgentFailure | undefined): string {
  const code = diagnostic?.code;
  switch (code) {
    case 'provider-auth': return 'The model provider denied access. Check the configured API key and permissions, then send a new message.';
    case 'provider-rate-limit': return 'The model provider is limiting requests. Wait a while, then send a new message.';
    case 'provider-unavailable': return 'The model provider is unavailable. Try a new message later.';
    case 'model-unavailable': return 'The configured model is unavailable for this request. Check the provider and model settings, then send a new message.';
    case 'provider-response': return 'The model provider returned an invalid response. Send a new message to try again.';
    case 'provider-error': return 'The model call failed before the assistant could finish. Check provider availability and configuration, then send a new message.';
    case 'invalid-tool-call': return 'The model did not finish a valid action. Send the message again.';
    case 'tool-execution': return 'The assistant could not evaluate this route change. Check the route and send a new message.';
    case 'output-limit': return 'The model response was cut short. Send a shorter, more specific message.';
    case 'internal-error': return 'The assistant encountered an internal error. Send a new message and use the request reference below if it continues.';
    case undefined: return 'The assistant could not complete this request. Send a new message to try again.';
    default: { const exhaustive: never = code; return exhaustive; }
  }
}

function eventMessage(event: AgentProgressEvent): string {
  if (event.kind === 'model-start') return 'Waiting for model response';
  if (event.kind === 'model-end') return 'Model response received';
  if (event.kind === 'terminal') return 'Request finished';
  if ('tool' in event) {
    const tool = {
      get_mission_context: 'Mission context', preview_change: 'Change preview',
      propose_change: 'Proposal', ask_clarification: 'Clarification',
    }[event.tool];
    return `${tool} ${event.kind === 'tool-start' ? 'started' : event.kind === 'tool-end' ? 'finished' : 'failed'}`;
  }
  return 'Model activity';
}

function outcomeMessage(outcome: Extract<AgentClientState['turn'], { kind: 'completed' }>['response']['outcome']): string | null {
  switch (outcome.kind) {
    case 'answered':
    case 'needs-input':
    case 'proposed': return null;
    case 'failed': return diagnosticMessage(outcome.diagnostic);
    case 'unavailable': return 'The assistant is not configured. Check the model provider settings, then send a new message.';
    case 'cancelled': return 'This request stopped. You can send a new message.';
    case 'deadline': return 'The assistant took too long. You can send a new message.';
    case 'budget-exceeded': return 'The assistant stopped before it could finish. Try a more specific message.';
    default: { const exhaustive: never = outcome; return exhaustive; }
  }
}

export function MissionChat({ analysis, state, pending, error, onSend, onCancel, onRetry, onReset, onSession }: MissionChatProps) {
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  const authenticated = state.session.kind === 'authenticated';
  const checking = state.session.kind === 'unknown' || state.session.kind === 'loading';
  const valid = analysis.route.kind === 'calculated';
  const terminal = state.turn.kind === 'completed' ? outcomeMessage(state.turn.response.outcome) : null;
  const progress = state.turn.kind === 'loading' || state.turn.kind === 'completed' ? state.turn.progress : null;
  const lastEvent = progress?.events.at(-1);
  const requestId = state.turn.kind === 'loading' ? state.turn.requestId
    : state.turn.kind === 'completed' ? state.turn.response.requestId
      : state.turn.kind === 'error' ? state.turn.requestId : undefined;
  const status = error ?? (pending ? lastEvent ? eventMessage(lastEvent) : 'Starting assistant request.'
    : state.turn.kind === 'error' ? state.turn.error.message
      : state.turn.kind === 'cancelled' ? 'Stopped waiting for this request. You can send a new message.' : terminal);

  return (
    <section className={styles.missionChat} aria-labelledby="mission-chat-title">
      <div className={styles.chatHeading}>
        <div>
          <span className={styles.eyebrow}>Mission assistant</span>
          <h2 id="mission-chat-title">Ask about this route</h2>
        </div>
        {authenticated && <div className={styles.chatActions}>
          {(state.history.length > 0 || pending || error !== null) && <button className={styles.secondaryButton} onClick={onReset} type="button">Clear conversation</button>}
          <button className={styles.quietButton} type="button" onClick={() => onSession({ action: 'logout' })}>Sign out</button>
        </div>}
      </div>
      <p className={styles.previewDescription}>Ask for a height change, then review the calculated result before applying it.</p>
      {!authenticated && (
        <div className={styles.chatAccess}>
          <p className={styles.previewDescription} role="status" aria-label="Assistant access">
            {checking ? 'Checking assistant access…' : state.session.kind === 'error'
              ? `${state.session.error.message} You can keep editing manually.`
              : 'Sign in to use the assistant. You can keep editing manually.'}
          </p>
          {!checking && <form className={styles.chatSignIn} onSubmit={(event) => {
            event.preventDefault();
            if (!password) return;
            onSession({ action: 'login', password });
            setPassword('');
          }}>
            <label className={styles.field}>
              <span>Assistant password</span>
              <input autoComplete="current-password" maxLength={256} onChange={(event) => setPassword(event.currentTarget.value)} type="password" value={password} />
            </label>
            <button className={styles.secondaryButton} disabled={!password} type="submit">Sign in</button>
            <button className={styles.quietButton} onClick={() => onSession({ action: 'status' })} type="button">Check access</button>
          </form>}
        </div>
      )}
      {state.history.length > 0 && <ol className={styles.chatMessages} aria-label="Assistant conversation" aria-live="polite" aria-relevant="additions text">
        {state.history.map((entry, index) => <li className={styles.chatMessage} key={index}>
          <span className={styles.chatSpeaker}>{entry.role === 'user' ? 'You' : 'Assistant'}</span>
          <p>{entry.content}</p>
        </li>)}
      </ol>}
      <form className={styles.chatCompose} onSubmit={(event) => {
        event.preventDefault();
        if (!authenticated || !valid || pending || !message.trim()) return;
        if (onSend(message)) setMessage('');
      }}>
        <label className={styles.field}>
          <span>Message</span>
          <textarea aria-describedby="mission-chat-guidance" disabled={!authenticated} maxLength={4000} onChange={(event) => setMessage(event.currentTarget.value)} placeholder="For example, raise this route to 40 metres" rows={3} value={message} />
        </label>
        <p id="mission-chat-guidance" className={styles.previewDescription}>
          {valid ? analysis.reviewEligible ? 'This route can use the assistant. Proposed changes still need your review.'
            : 'This route can use the assistant. Takeoff is still required before marking it as reviewed.'
            : 'Complete the waypoint coordinates, height and framing settings before sending. Takeoff is optional for chat.'}
        </p>
        {status !== null && <p className={styles.chatStatus} aria-label="Assistant request status" role="status">{status}</p>}
        {pending && state.turn.kind === 'loading' && <p className={styles.chatElapsed}>Elapsed {Math.floor(state.turn.elapsedMs / 1_000)} seconds</p>}
        {requestId && <details className={styles.chatDetails}>
          <summary>Request details</summary>
          <p>Reference: <code>{requestId}</code></p>
          {state.turn.kind === 'completed' && <p>Duration: {(state.turn.elapsedMs / 1_000).toFixed(1)} seconds</p>}
          {state.turn.kind === 'completed' && state.turn.response.outcome.kind === 'failed' && state.turn.response.outcome.diagnostic && <p>
            Diagnosis: <code>{state.turn.response.outcome.diagnostic.code}</code>
            {state.turn.response.outcome.diagnostic.status !== undefined && ` · Provider status: ${state.turn.response.outcome.diagnostic.status}`}
          </p>}
          {progress && progress.events.length > 0 && <ol aria-label="Assistant activity">
            {progress.events.map((event, index) => <li key={index}>{eventMessage(event)} · {Math.floor(event.elapsedMs / 1_000)}s</li>)}
          </ol>}
        </details>}
        <div className={styles.chatActions}>
          {pending && <button className={styles.quietButton} onClick={onCancel} type="button">Cancel request</button>}
          {!pending && state.turn.kind === 'error' && state.turn.retryAvailable && <button className={styles.secondaryButton} onClick={onRetry} type="button">Retry same request</button>}
          <button className={styles.secondaryButton} disabled={!authenticated || !valid || pending || !message.trim()} type="submit">Send</button>
        </div>
      </form>
    </section>
  );
}
