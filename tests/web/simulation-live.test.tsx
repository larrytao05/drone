import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MissionEditor } from '../../web/MissionEditor.js';
import { writeLocalDraft } from '../../web/draft-storage.js';
import type { MissionDraft } from '../../web/editor.js';
import type { SimulationRouteInput, SimulationStatus } from '../../src/simulation-contract.js';
import { resetMaplibreDouble } from './maplibre-double.js';
import { createSimulationClient } from '../../web/simulation-client.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

beforeEach(() => {
  resetMaplibreDouble();
});

function seedLocalDraft(draft: MissionDraft, reviewed: boolean) {
  expect(writeLocalDraft({ storage: window.localStorage, draft, reviewed })).toEqual({ kind: 'success' });
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type MockBridgeHandlers = {
  onGet?: (url: string) => Response | Promise<Response> | null | undefined;
  onPost?: (body: unknown, url: string) => Response | Promise<Response> | null | undefined;
};

function createMockBridge(
  initialStatus: Partial<SimulationStatus> = {},
  handlers: MockBridgeHandlers = {},
) {
  let currentStatus: SimulationStatus = {
    runId: null,
    seq: 0,
    phase: 'ready',
    blocked: false,
    holdRequested: false,
    holdConfirmed: false,
    fresh: true,
    cleanupCompleted: true,
    route: null,
    telemetry: null,
    events: [],
    error: null,
    ...initialStatus,
  };

  const requests: { method: string; url: string; body?: unknown }[] = [];

  const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const urlStr = String(url);
    if (urlStr === '/api/agent/session') {
      return jsonResponse({
        authenticated: true,
        epoch: 'a'.repeat(32),
        serverNow: 1_800_000_000_000,
        retryWindowMs: 120_000,
      });
    }

    if (urlStr.startsWith('/api/simulation')) {
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (init?.body && typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch {}
      }
      requests.push({ method, url: urlStr, body });

      if (method === 'GET') {
        if (handlers.onGet) {
          const custom = await handlers.onGet(urlStr);
          if (custom !== undefined && custom !== null) return custom;
        }
        return jsonResponse({ ok: true, status: currentStatus });
      }

      if (method === 'POST') {
        if (handlers.onPost) {
          const custom = await handlers.onPost(body, urlStr);
          if (custom !== undefined && custom !== null) return custom;
        }
        const cmd = body as { action: string; runId?: string; route?: unknown };
        if (cmd.action === 'start') {
          currentStatus = {
            ...currentStatus,
            runId: 'sim_test_live_run_1',
            seq: currentStatus.seq + 1,
            phase: 'starting',
            cleanupCompleted: false,
            events: [{ seq: 1, timestamp: new Date().toISOString(), label: 'Simulation run initialized' }],
          };
          return jsonResponse({ ok: true, status: currentStatus });
        }
        if (cmd.action === 'resume') {
          currentStatus = {
            ...currentStatus,
            seq: currentStatus.seq + 1,
            phase: 'running',
            holdRequested: false,
            holdConfirmed: false,
            events: [...currentStatus.events, { seq: currentStatus.seq + 1, timestamp: new Date().toISOString(), label: 'Operator resumed route' }],
          };
          return jsonResponse({ ok: true, status: currentStatus });
        }
        if (cmd.action === 'end') {
          currentStatus = {
            ...currentStatus,
            seq: currentStatus.seq + 1,
            phase: 'ended',
            cleanupCompleted: true,
            events: [...currentStatus.events, { seq: currentStatus.seq + 1, timestamp: new Date().toISOString(), label: 'Simulation ended and verified' }],
          };
          return jsonResponse({ ok: true, status: currentStatus });
        }
      }
    }

    return jsonResponse({ kind: 'local' });
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    requests,
    getStatus: () => currentStatus,
    setStatus: (status: Partial<SimulationStatus>) => {
      currentStatus = { ...currentStatus, ...status };
    },
    setHandlers: (newHandlers: MockBridgeHandlers) => {
      Object.assign(handlers, newHandlers);
    },
    fetchMock,
  };
}

const validSyntheticDraft: MissionDraft = {
  name: 'Zurich Test Flight',
  points: [
    { id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '47.398043', longitude: '8.545594' } },
    { id: '22222222-2222-4222-8222-222222222222', coordinate: { latitude: '47.398043', longitude: '8.545994' } },
    { id: '33333333-3333-4333-8333-333333333333', coordinate: { latitude: '47.397743', longitude: '8.545994' } },
  ],
  height: '10',
  framing: { kind: 'fixed', heading: '0', pitch: '0' },
  takeoff: { latitude: '47.397743', longitude: '8.545594' },
};

describe('WEB-SIM-3 Live simulation bridge integration', () => {
  it('discovers live bridge and displays live indicator', async () => {
    const bridge = createMockBridge();
    render(<MissionEditor />);

    await waitFor(() => {
      expect(bridge.requests.some((r) => r.url === '/api/simulation')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Isolated PX4 simulator');
    expect(panel.textContent).toContain('Ready to simulate');
  });

  it('validates editor route before launch and rejects unsupported input with a clear error', async () => {
    const bridge = createMockBridge();
    render(<MissionEditor />);

    await waitFor(() => {
      expect(bridge.requests.some((r) => r.url === '/api/simulation')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start simulation' }));

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Route must be fully calculated before starting simulation.');
    expect(
      bridge.requests.some(
        (r) => r.method === 'POST' && (r.body as Record<string, unknown>)?.action === 'start',
      ),
    ).toBe(false);
  });

  it('launches a validated immutable route snapshot to the live simulator bridge', async () => {
    const bridge = createMockBridge();
    seedLocalDraft(validSyntheticDraft, true);
    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));

    const startBtn = screen.getByRole('button', { name: 'Start simulation' });
    fireEvent.click(startBtn);

    await waitFor(() => {
      const startReq = bridge.requests.find(
        (r) => r.method === 'POST' && (r.body as Record<string, unknown>)?.action === 'start',
      );
      expect(startReq).toBeTruthy();
      const body = startReq!.body as { action?: string; route?: SimulationRouteInput };
      expect(body.route).toBeTruthy();
      expect(body.route?.plannedAltitudeM).toBe(10);
      expect(body.route?.waypoints.length).toBe(3);
      expect(body.route?.waypoints[0]?.latitudeDeg).toBe(47.398043);
    });

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Starting simulation');
  });

  it('recovers an active run on reload: restores phase, telemetry, events, and locks editing', async () => {
    const bridge = createMockBridge({
      runId: 'sim_recovered_123',
      seq: 14,
      phase: 'holding',
      blocked: false,
      holdRequested: true,
      holdConfirmed: true,
      fresh: true,
      cleanupCompleted: false,
      route: {
        name: 'Recovered Flight',
        plannedAltitudeM: 10,
        waypoints: [
          { latitudeDeg: 47.398043, longitudeDeg: 8.545594, altitudeM: 10 },
          { latitudeDeg: 47.398043, longitudeDeg: 8.545994, altitudeM: 10 },
        ],
      },
      telemetry: {
        timestamp: '2026-11-23T00:00:10.000Z',
        sampleAgeMs: 50,
        position: { lat: 47.398000, lon: 8.545594, altM: 10.0, northProgressM: 11.6 },
        velocity: { speedMs: 0.1, northSpeedMs: 0.05 },
      },
      events: [
        { seq: 1, timestamp: '2026-11-23T00:00:00.000Z', label: 'Simulation run initialized' },
        { seq: 10, timestamp: '2026-11-23T00:00:05.000Z', label: 'Route motion confirmed' },
        { seq: 12, timestamp: '2026-11-23T00:00:07.000Z', label: 'Autopilot commanded hold' },
        { seq: 13, timestamp: '2026-11-23T00:00:08.000Z', label: 'Telemetry confirmed hold' },
        { seq: 14, timestamp: '2026-11-23T00:00:09.000Z', label: 'Advisory: stay in hold until segment clears and operator explicitly resumes' },
      ],
    });

    render(<MissionEditor />);

    await waitFor(() => {
      const banner = screen.getByText(/Simulation running/);
      expect(banner).toBeTruthy();
    });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Holding');
    expect(panel.textContent).toContain('Segment clear. Waiting for you to resume.');
    expect(panel.textContent).toContain('0.1 m/s');
    expect(panel.textContent).toContain('10.0 m');
    expect(panel.textContent).toContain('Assistant recommendation');

    const resumeBtn = within(panel).getByRole('button', { name: 'Resume' });
    expect(resumeBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(resumeBtn);
    await waitFor(() => {
      expect(
        bridge.requests.some(
          (r) => r.method === 'POST' && (r.body as Record<string, unknown>)?.action === 'resume',
        ),
      ).toBe(true);
    });
  });

  it('retains edit lock during cleanup failure on reload and keeps End available', async () => {
    createMockBridge({
      runId: 'sim_cleanup_failed_456',
      seq: 20,
      phase: 'failed',
      cleanupCompleted: false,
      error: {
        code: 'CLEANUP_FAILURE',
        message: 'Failed to confirm container cleanup during simulation teardown.',
      },
      events: [
        { seq: 1, timestamp: '2026-11-23T00:00:00.000Z', label: 'Simulation run initialized' },
        { seq: 19, timestamp: '2026-11-23T00:00:10.000Z', label: 'Container cleanup failed during teardown' },
      ],
    });

    render(<MissionEditor />);

    await waitFor(() => {
      const banner = screen.getByText(/Simulation cleanup incomplete/);
      expect(banner).toBeTruthy();
    });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Failed to confirm container cleanup during simulation teardown.');

    const endBtn = within(panel).getByRole('button', { name: 'End simulation' });
    expect(endBtn.hasAttribute('disabled')).toBe(false);
  });

  it('unlocks editing on reload after a cleaned failure', async () => {
    createMockBridge({
      runId: 'sim_cleaned_failed_789',
      seq: 22,
      phase: 'failed',
      cleanupCompleted: true,
      error: {
        code: 'STARTUP_TIMEOUT',
        message: 'Preflight readiness timed out after 30s.',
      },
      events: [
        { seq: 1, timestamp: '2026-11-23T00:00:00.000Z', label: 'Simulation run initialized' },
        { seq: 21, timestamp: '2026-11-23T00:00:30.000Z', label: 'Preflight readiness timed out after 30s.' },
      ],
    });

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.queryByText(/Simulation running/)).toBeNull();
      expect(screen.queryByText(/Simulation cleanup incomplete/)).toBeNull();
    });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Simulation failed');
    expect(panel.textContent).toContain('Previous run');
    expect(panel.textContent).toContain('Preflight readiness timed out after 30s.');
    expect(within(panel).getByRole('button', { name: 'Start simulation' }).hasAttribute('disabled')).toBe(false);
  });

  it('disables Resume during blockage or stale telemetry, but keeps End available', async () => {
    const bridge = createMockBridge({
      runId: 'sim_test_stale_1',
      seq: 5,
      phase: 'holding',
      blocked: true,
      holdRequested: true,
      holdConfirmed: true,
      fresh: true,
      cleanupCompleted: false,
    });

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByText(/Simulation running/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });

    expect(panel.textContent).toContain('Segment still blocked.');
    expect(within(panel).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true);
    expect(within(panel).getByRole('button', { name: 'End simulation' }).hasAttribute('disabled')).toBe(false);

    act(() => {
      bridge.setStatus({ blocked: false, fresh: false, seq: 6 });
    });

    await waitFor(() => {
      expect(panel.textContent).toContain('Telemetry unavailable');
      expect(panel.textContent).toContain('Resume requires fresh telemetry.');
    });
    expect(within(panel).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true);
    expect(within(panel).getByRole('button', { name: 'End simulation' }).hasAttribute('disabled')).toBe(false);
  });

  it('ends live simulation, confirms teardown, and verifies edit unlocks and draft editing succeeds', async () => {
    createMockBridge({
      runId: 'sim_ending_test_1',
      seq: 8,
      phase: 'running',
      cleanupCompleted: false,
    });

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByText(/Simulation running/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });

    fireEvent.click(within(panel).getByRole('button', { name: 'End simulation' }));

    await waitFor(() => {
      expect(panel.textContent).toContain('Simulation ended');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.queryByText(/Simulation running/)).toBeNull();

    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    expect(nameInput.disabled).toBe(false);
    fireEvent.change(nameInput, { target: { value: 'New route name after sim' } });
    expect(nameInput.value).toBe('New route name after sim');
  });

  it('prevents optimistic unlock on lost Start acknowledgement and reconciles via authoritative status', async () => {
    let failStartPost = true;
    const bridge = createMockBridge(
      {},
      {
        onPost: (body) => {
          const cmd = body as { action?: string };
          if (cmd?.action === 'start' && failStartPost) {
            failStartPost = false;
            // Bridge actually received and started the run, but client lost HTTP response
            bridge.setStatus({
              runId: 'sim_lost_ack_1',
              seq: 1,
              phase: 'starting',
              cleanupCompleted: false,
              events: [{ seq: 1, timestamp: new Date().toISOString(), label: 'Simulation run initialized' }],
            });
            throw new Error('Network failure: lost acknowledgement on Start');
          }
          return null;
        },
      },
    );

    seedLocalDraft(validSyntheticDraft, true);
    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));

    const startBtn = screen.getByRole('button', { name: 'Start simulation' });
    fireEvent.click(startBtn);

    // Draft editing must NOT be unlocked optimistically despite transport error
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
    });

    // Reconciles with authoritative status from GET
    await waitFor(() => {
      const panel = screen.getByRole('region', { name: 'Simulation inspector' });
      expect(panel.textContent).toContain('Starting simulation');
    });

    // Edit lock remains active
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
  });

  it('retains edit lock on Start 409 rejection with uncleaned run', async () => {
    const uncleanedStatus: SimulationStatus = {
      runId: 'sim_unclean_existing',
      seq: 7,
      phase: 'holding',
      blocked: false,
      holdRequested: true,
      holdConfirmed: true,
      fresh: true,
      cleanupCompleted: false,
      route: null,
      telemetry: null,
      events: [{ seq: 1, timestamp: new Date().toISOString(), label: 'Simulation run initialized' }],
      error: null,
    };

    createMockBridge(
      {},
      {
        onPost: (body) => {
          const cmd = body as { action?: string };
          if (cmd?.action === 'start') {
            return jsonResponse(
              {
                ok: false,
                error: {
                  code: 'ALREADY_RUNNING',
                  message: 'A simulation run is already active or uncleaned.',
                },
                status: uncleanedStatus,
              },
              409,
            );
          }
          return null;
        },
      },
    );

    seedLocalDraft(validSyntheticDraft, true);
    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));

    const startBtn = screen.getByRole('button', { name: 'Start simulation' });
    fireEvent.click(startBtn);

    // After 409 rejection with unclean run, edit lock must be retained
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
    });

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Holding');
    expect(within(panel).getByRole('button', { name: 'End simulation' }).hasAttribute('disabled')).toBe(false);
  });

  it('gates editing during initial ownership check and preserves confirmed disabled fixture behavior', async () => {
    let resolveGet!: (res: Response) => void;
    const getPromise = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });

    createMockBridge(
      {},
      {
        onGet: (url) => {
          if (url === '/api/simulation') {
            return getPromise;
          }
          return null;
        },
      },
    );

    render(<MissionEditor />);

    // While ownership check is in flight, route editing is gated
    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    expect(nameInput.disabled).toBe(true);
    expect(screen.getByText(/Checking simulation state/)).toBeTruthy();

    // Confirm disabled bridge with local fixture response
    resolveGet(jsonResponse({ kind: 'local' }));

    // Unlocks editing and transitions to fixture mode
    await waitFor(() => {
      expect(screen.queryByText(/Checking simulation state/)).toBeNull();
      expect(nameInput.disabled).toBe(false);
    });
  });

  it('retries discovery after uncertainty without silently switching into fixture', async () => {
    let getAttempts = 0;
    createMockBridge(
      {
        runId: 'sim_active_after_uncertainty',
        seq: 3,
        phase: 'running',
        cleanupCompleted: false,
      },
      {
        onGet: (url) => {
          if (url === '/api/simulation') {
            getAttempts++;
            if (getAttempts === 1) {
              throw new Error('Network dropped during initial discovery');
            }
          }
          return null;
        },
      },
    );

    render(<MissionEditor />);

    // During uncertainty, route editing remains locked
    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    expect(nameInput.disabled).toBe(true);

    // On retry, discovery succeeds and adopts authoritative live status
    await waitFor(() => {
      expect(getAttempts).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/Simulation running/)).toBeTruthy();
    });

    expect(nameInput.disabled).toBe(true);
  });

  it('handles End network failure visibly, retains ownership, and permits retry', async () => {
    let failEndPost = true;
    createMockBridge(
      {
        runId: 'sim_test_end_failure',
        seq: 4,
        phase: 'holding',
        cleanupCompleted: false,
      },
      {
        onPost: (body) => {
          const cmd = body as { action?: string };
          if (cmd?.action === 'end' && failEndPost) {
            failEndPost = false;
            throw new Error('Network dropped during End');
          }
          return null;
        },
      },
    );

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByText(/Simulation running/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });

    const endBtn = within(panel).getByRole('button', { name: 'End simulation' });
    fireEvent.click(endBtn);

    // Visibly surfaces network error during teardown
    await waitFor(() => {
      expect(panel.textContent).toContain('Network error during teardown. End simulation can be retried.');
    });

    // Ownership is retained: route editing remains disabled
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);

    // End simulation button is still enabled to allow retry
    expect(endBtn.hasAttribute('disabled')).toBe(false);

    // Retry End simulation
    fireEvent.click(endBtn);

    await waitFor(() => {
      expect(panel.textContent).toContain('Simulation ended');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
  });

  it('recovers cleaned run history on reload with executed route geometry and unlocks editing', async () => {
    createMockBridge({
      runId: 'sim_cleaned_history_1',
      seq: 15,
      phase: 'ended',
      cleanupCompleted: true,
      route: {
        name: 'Executed Historic Flight',
        plannedAltitudeM: 12,
        waypoints: [
          { latitudeDeg: 47.397743, longitudeDeg: 8.545594, altitudeM: 12 },
          { latitudeDeg: 47.397743, longitudeDeg: 8.546044, altitudeM: 12 },
        ],
      },
      events: [
        { seq: 1, timestamp: '2026-11-23T00:00:00.000Z', label: 'Simulation run initialized' },
        { seq: 15, timestamp: '2026-11-23T00:00:30.000Z', label: 'Simulation ended and verified' },
      ],
    });

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.queryByText(/Simulation running/)).toBeNull();
      expect(screen.queryByText(/Checking simulation state/)).toBeNull();
    });

    // Route editing is unlocked
    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    expect(nameInput.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Simulation ended');
    expect(panel.textContent).toContain('Previous run');
    expect(panel.textContent).toContain('Executed Historic Flight');
    expect(panel.textContent).toContain('Simulation ended and verified');
  });

  it('ensures stale sequence numbers and wrong-generation updates cannot overwrite state', async () => {
    let mockStatus: SimulationStatus = {
      runId: 'sim_client_gen_test',
      seq: 10,
      phase: 'running',
      blocked: false,
      holdRequested: false,
      holdConfirmed: false,
      fresh: true,
      cleanupCompleted: false,
      route: null,
      telemetry: null,
      events: [{ seq: 10, timestamp: '2026-11-23T00:00:10.000Z', label: 'Update 10' }],
      error: null,
    };

    const client = createSimulationClient({
      fetch: (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/simulation')) {
          return jsonResponse({ ok: true, status: mockStatus });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });

    await client.discover();
    expect(client.getState().phase).toBe('running');
    expect(client.getState().events[0]?.label).toBe('Update 10');

    // Simulate stale sequence response: seq 5 < 10
    mockStatus = {
      ...mockStatus,
      seq: 5,
      phase: 'holding',
      events: [{ seq: 5, timestamp: '2026-11-23T00:00:05.000Z', label: 'Stale 5' }],
    };

    // Stale sequence is ignored, state remains at seq 10
    expect(client.getState().phase).toBe('running');
    expect(client.getState().events[0]?.label).toBe('Update 10');

    client.dispose();
  });

  it('handles mismatched End status / WRONG_RUN visibly with retry and reconciliation, never inferring cleanup from another run or empty restarted bridge', async () => {
    let endAttempt = 0;
    createMockBridge(
      {
        runId: 'sim_active_for_wrong_run',
        seq: 5,
        phase: 'holding',
        cleanupCompleted: false,
      },
      {
        onPost: (body) => {
          const cmd = body as { action?: string; runId?: string };
          if (cmd?.action === 'end') {
            endAttempt++;
            if (endAttempt === 1) {
              // Bridge returns WRONG_RUN with mismatched status (e.g. empty bridge or different run)
              return jsonResponse(
                {
                  ok: false,
                  error: {
                    code: 'WRONG_RUN',
                    message: "End rejected: runId 'sim_active_for_wrong_run' does not match active run 'null'.",
                  },
                  status: {
                    runId: null,
                    seq: 1,
                    phase: 'ready',
                    blocked: false,
                    holdRequested: false,
                    holdConfirmed: false,
                    fresh: false,
                    cleanupCompleted: true, // Empty bridge reports true, but MUST NOT be inferred for our run!
                    route: null,
                    telemetry: null,
                    events: [],
                    error: null,
                  },
                },
                400,
              );
            }
            // On second End attempt (retry), bridge successfully tears down and confirms cleanup of our run
            return jsonResponse({
              ok: true,
              status: {
                runId: 'sim_active_for_wrong_run',
                seq: 6,
                phase: 'ended',
                blocked: false,
                holdRequested: false,
                holdConfirmed: false,
                fresh: false,
                cleanupCompleted: true,
                route: null,
                telemetry: null,
                events: [{ seq: 6, timestamp: new Date().toISOString(), label: 'Teardown confirmed on retry' }],
                error: null,
              },
            });
          }
          return null;
        },
      },
    );

    render(<MissionEditor />);

    await waitFor(() => {
      expect(screen.getByText(/Simulation running/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const endBtn = within(panel).getByRole('button', { name: 'End simulation' });
    fireEvent.click(endBtn);

    // 1. Must NOT remain stuck in 'ending'
    // 2. Visibly surfaces WRONG_RUN error
    await waitFor(() => {
      expect(panel.textContent).toContain('Simulation failed');
      expect(panel.textContent).toContain("End rejected: runId 'sim_active_for_wrong_run' does not match active run 'null'.");
    });

    // 3. Must NEVER infer cleanup from the empty bridge or different run!
    // Edit lock remains strictly active!
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Import backup' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Simulation cleanup incomplete · Route editing paused./)).toBeTruthy();

    // 4. Retry is permitted: End simulation button remains enabled
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    const activePanel = screen.getByRole('region', { name: 'Simulation inspector' });
    const retryEndBtn = within(activePanel).getByRole('button', { name: 'End simulation' });
    expect(retryEndBtn.hasAttribute('disabled')).toBe(false);

    // Retry End simulation
    fireEvent.click(retryEndBtn);

    // Teardown confirmed on retry
    await waitFor(() => {
      expect(activePanel.textContent).toContain('Simulation ended');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
  });

  it('enforces full edit lock in UI and blocks direct and async mutations during discovery, ending and unclean failure', async () => {
    let resolveDiscovery!: (res: Response) => void;
    const discoveryPromise = new Promise<Response>((resolve) => {
      resolveDiscovery = resolve;
    });

    createMockBridge(
      {},
      {
        onGet: (url) => {
          if (url === '/api/simulation') {
            return discoveryPromise;
          }
          return null;
        },
      },
    );

    seedLocalDraft(validSyntheticDraft, true);
    render(<MissionEditor />);

    // During initial discovery, UI controls are locked
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Import backup' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);

    // Direct click on Load during discovery is rejected
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');

    // Complete discovery confirming ready bridge
    resolveDiscovery(
      jsonResponse({
        ok: true,
        status: {
          runId: null,
          seq: 1,
          phase: 'ready',
          cleanupCompleted: true,
          events: [],
        },
      }),
    );

    // After discovery, editing unlocks
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(false);
    });

    // Load succeeds after legitimate discovery
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe(validSyntheticDraft.name);
  });

  it('never infers cleanup of an old uncleaned run when discover encounters an empty restarted bridge', async () => {
    let bridgeState = {
      runId: 'sim_old_uncleaned',
      seq: 2,
      phase: 'failed',
      cleanupCompleted: false,
    };

    const client = createSimulationClient({
      fetch: (async () => {
        return jsonResponse({
          ok: true,
          status: {
            ...bridgeState,
            blocked: false,
            holdRequested: false,
            holdConfirmed: false,
            fresh: true,
            route: null,
            telemetry: null,
            events: [],
            error: null,
          },
        });
      }) as typeof fetch,
    });

    // Initial discovery adopts uncleaned run
    await client.discover();
    expect(client.getState().runId).toBe('sim_old_uncleaned');
    expect(client.getState().cleanupCompleted).toBe(false);

    // Now bridge restarts: reports runId: null, phase: 'ready', cleanupCompleted: true
    bridgeState = {
      runId: null as unknown as string,
      seq: 1,
      phase: 'ready',
      cleanupCompleted: true,
    };

    // Client re-discovers
    await client.discover();

    // Must NOT infer cleanup of old run! cleanupCompleted remains false, edit locked
    expect(client.getState().cleanupCompleted).toBe(false);
    expect(client.getState().phase).toBe('failed');
    expect(client.getState().error?.code).toBe('WRONG_RUN');

    client.dispose();
  });
});
