import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { agentRequestSchema, type AgentRequest, type AgentResponse } from '../../src/agent-contract.js';
import { MissionEditor } from '../../web/MissionEditor.js';
import { encodeBackup, writeLocalDraft } from '../../web/draft-storage.js';
import { makeDraft } from './fixtures.js';
import type { MissionDraft } from '../../web/editor.js';
import { createdMaps, resetMaplibreDouble } from './maplibre-double.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

beforeEach(() => {
  resetMaplibreDouble();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: 'local' }) }));
});

function seedLocalDraft(draft: MissionDraft, reviewed: boolean) {
  expect(writeLocalDraft({ storage: window.localStorage, draft, reviewed })).toEqual({ kind: 'success' });
}

function fileWithText(name: string, text: string): File {
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not ready'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function networkAgent() {
  const requests: { request: AgentRequest; signal: AbortSignal | null | undefined; reply: (response: Response) => void }[] = [];
  const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (url === '/api/agent/session') {
      return jsonResponse({ authenticated: true, epoch: 'a'.repeat(32), serverNow: 1_800_000_000_000, retryWindowMs: 120_000 });
    }
    if (init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body);
        const parseResult = agentRequestSchema.safeParse(parsed);
        if (parseResult.success) {
          const response = deferred<Response>();
          requests.push({ request: parseResult.data, signal: init?.signal, reply: response.resolve });
          return response.promise;
        }
      } catch {
        // Not JSON
      }
    }
    return jsonResponse({ kind: 'local' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetch: fetchMock };
}

function proposedResponse(request: AgentRequest, height = 40): AgentResponse {
  return {
    requestId: request.requestId,
    binding: request.binding,
    outcome: {
      kind: 'proposed',
      change: { kind: 'set-height', heightAboveTakeoffM: height },
      activity: [],
    },
  };
}

function goToSimulation() {
  fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
}

function goToEdit() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
}

function getStartButton() {
  return screen.getByRole('button', { name: 'Start simulation' });
}

function startSimulation() {
  goToSimulation();
  fireEvent.click(getStartButton());
}

describe('editor view tabs', () => {
  it('shows Edit and Simulation tabs', () => {
    render(<MissionEditor />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Simulation' })).toBeTruthy();
  });

  it('defaults to the Edit tab', () => {
    render(<MissionEditor />);
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Simulation' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switches tabs', () => {
    render(<MissionEditor />);
    goToSimulation();
    expect(screen.getByRole('button', { name: 'Simulation' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows ready state with route info on Simulation tab', () => {
    seedLocalDraft(makeDraft(), true);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    goToSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Ready to simulate');
    expect(screen.getByLabelText('Map legend').textContent).toBe('Planned route · 2 waypoints');
    expect(panel.textContent).toContain('Start simulation');
  });
});

describe('simulation lifecycle', () => {
  it('starts a simulation and shows running state', () => {
    render(<MissionEditor />);
    startSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    expect(status.textContent).toContain('Running');
    expect(status.textContent).toContain('Following the planned route.');
    expect(status.textContent).toContain('Speed');
    expect(status.textContent).toContain('4.0 m/s');
    expect(status.textContent).toContain('Simulation started');
  });

  it('blocks, holds, clears, and resumes', () => {
    render(<MissionEditor />);
    startSimulation();

    // Block
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    expect(status.textContent).toContain('Holding');
    expect(status.textContent).toContain('Segment still blocked.');
    expect(status.textContent).toContain('0.0 m/s');
    expect(status.textContent).toContain('Autopilot commanded hold');

    // Resume should be disabled while blocked
    expect(within(status).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true);

    // Clear
    fireEvent.click(screen.getByRole('button', { name: 'Clear blockage' }));
    expect(status.textContent).toContain('Waiting for you to resume.');
    expect(within(status).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(false);

    // Resume
    fireEvent.click(within(status).getByRole('button', { name: 'Resume' }));
    expect(status.textContent).toContain('Running');
    expect(status.textContent).toContain('Operator resumed the route');
  });

  it('handles stale telemetry blocking resume', () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drop telemetry' }));

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    expect(status.textContent).toContain('Telemetry unavailable');
    expect(status.textContent).toContain('Resume requires fresh telemetry.');
    expect(within(status).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true);

    // Clear and restore
    fireEvent.click(screen.getByRole('button', { name: 'Clear blockage' }));
    // Still stale — resume still blocked
    expect(within(status).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true);

    // Restore telemetry
    fireEvent.click(screen.getByRole('button', { name: 'Restore telemetry' }));
    expect(within(status).getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(false);
  });

  it('ends a simulation and shows ended state', () => {
    render(<MissionEditor />);
    startSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));
    expect(status.textContent).toContain('Simulation ended');
    expect(status.textContent).toContain('Start simulation');
  });

  it('can restart after ending', () => {
    render(<MissionEditor />);
    startSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));
    fireEvent.click(within(status).getByRole('button', { name: 'Start simulation' }));
    expect(status.textContent).toContain('Running');
  });
});

describe('edit locking during simulation', () => {
  it('shows banner on Edit tab during active simulation', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    const banner = screen.getByText(/Simulation running/);
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Route editing paused');
  });

  it('provides Back to Simulation button in banner', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Simulation' }));
    expect(screen.getByRole('button', { name: 'Simulation' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('disables route name input during simulation', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);
  });

  it('disables map tools during simulation', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    const selectButton = screen.getByRole('button', { name: 'Select' });
    expect(selectButton.hasAttribute('disabled')).toBe(true);
    const addPoints = screen.getByRole('button', { name: 'Add points' });
    expect(addPoints.hasAttribute('disabled')).toBe(true);
  });

  it('disables New button during simulation', () => {
    render(<MissionEditor />);
    startSimulation();

    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables Load and Import during simulation', () => {
    render(<MissionEditor />);
    startSimulation();

    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Import backup' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables inspector fields on Edit tab during active simulation', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff latitude' }).disabled).toBe(true);
  });

  it('rejects loading draft during simulation even if storage has data', () => {
    const draft = makeDraft({ name: 'Loaded route' });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    // Load button is disabled
    const loadButton = screen.getByRole('button', { name: 'Load' });
    expect(loadButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(loadButton);

    // Route name remains unchanged
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');
  });

  it('rejects import during active simulation', async () => {
    const draft = makeDraft({ name: 'Imported route' });
    const backupText = encodeBackup(draft);
    const file = fileWithText('backup.json', backupText);

    render(<MissionEditor />);
    startSimulation();
    goToEdit();

    const importInput = screen.getByLabelText('Import backup');
    fireEvent.change(importInput, { target: { files: [file] } });

    // Draft does not change
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');
  });

  it('unlocks editing after end', () => {
    render(<MissionEditor />);
    startSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).disabled).toBe(false);
  });

  it('no banner on Edit tab when simulation is not active', () => {
    render(<MissionEditor />);
    goToEdit();
    expect(screen.queryByText(/Simulation running/)).toBeNull();
  });
});

describe('tab switching preserves run state', () => {
  it('switching to Edit and back keeps the same run', () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    goToEdit();
    goToSimulation();

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    expect(status.textContent).toContain('Holding');
    expect(status.textContent).toContain('Autopilot commanded hold');
  });
});

describe('demo controls visibility', () => {
  it('shows demo controls on Simulation tab during active run', () => {
    render(<MissionEditor />);
    startSimulation();
    expect(screen.getByRole('region', { name: 'Demo controls' })).toBeTruthy();
  });

  it('hides demo controls on Edit tab', () => {
    render(<MissionEditor />);
    startSimulation();
    goToEdit();
    expect(screen.queryByRole('region', { name: 'Demo controls' })).toBeNull();
  });

  it('hides demo controls when not running', () => {
    render(<MissionEditor />);
    goToSimulation();
    expect(screen.queryByRole('region', { name: 'Demo controls' })).toBeNull();
  });
});

describe('advisory display', () => {
  it('shows advisory after block', () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Assistant recommendation');
    expect(panel.textContent).toContain('Stay in hold');
  });
});

describe('End only from Simulation tab', () => {
  it('End simulation button is only on the Simulation tab', () => {
    render(<MissionEditor />);
    startSimulation();

    // End simulation is visible on Simulation tab
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(within(panel).getByRole('button', { name: 'End simulation' })).toBeTruthy();

    // Switch to Edit — no End simulation
    goToEdit();
    expect(screen.queryByRole('button', { name: 'End simulation' })).toBeNull();
  });
});

describe('route summary', () => {
  it('shows route name and info in ready and ended state', () => {
    render(<MissionEditor />);
    goToSimulation();

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    expect(panel.textContent).toContain('Untitled route');
    expect(panel.textContent).toContain('0 waypoints');

    startSimulation();
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    expect(panel.textContent).toContain('Simulation ended');
    expect(panel.textContent).toContain('Untitled route');
    expect(panel.textContent).toContain('0 waypoints');
  });
});

describe('fixture map overlays', () => {
  it('shows map legend on Simulation tab in ready state', () => {
    render(<MissionEditor />);
    goToSimulation();

    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toContain('Planned route');
  });

  it('shows drone position marker and planned route legend when running', async () => {
    render(<MissionEditor />);
    startSimulation();

    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toContain('Simulated drone · Planned route');

    const drone = await screen.findByRole('img', { name: 'Simulated drone position' });
    expect(drone).toBeTruthy();
    expect(drone.textContent).toContain('Simulated drone');
  });

  it('shows blocked segment overlay and legend when blocked', async () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toContain('Blocked segment · WP 2 to WP 3');

    const blockedOverlay = await screen.findByRole('note', { name: 'Blocked segment indicator' });
    expect(blockedOverlay.textContent).toContain('Blocked segment · WP 2 to WP 3');
  });

  it('labels marker and legend Last known position when telemetry is dropped', async () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Drop telemetry' }));

    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toContain('Last known position');

    const marker = await screen.findByRole('img', { name: 'Last known position' });
    expect(marker).toBeTruthy();
    expect(marker.textContent).toContain('Last known position');

    // Restore telemetry restores marker
    fireEvent.click(screen.getByRole('button', { name: 'Restore telemetry' }));
    expect(await screen.findByRole('img', { name: 'Simulated drone position' })).toBeTruthy();
  });

  it('confines the overlay and legend inside the map frame so status panel is not overlapped', () => {
    render(<MissionEditor />);
    startSimulation();

    const overlay = screen.getByLabelText('Simulation map overlay');
    const mapSection = screen.getByRole('region', { name: 'Mission map' });
    const mapFrame = mapSection.firstElementChild;
    const statusPanel = mapSection.querySelector('[aria-label="Map status"]')?.parentElement;

    // Overlay is a child of mapFrame
    expect(mapFrame?.contains(overlay)).toBe(true);

    // Status panel is sibling to mapFrame, not inside overlay
    expect(overlay.contains(statusPanel ?? null)).toBe(false);

    // Legend is inside mapFrame
    const legend = screen.getByLabelText('Map legend');
    expect(mapFrame?.contains(legend)).toBe(true);
  });

  it('moves the simulated drone along route geometry as progress advances', async () => {
    render(<MissionEditor />);
    startSimulation();

    const droneStart = await screen.findByRole('img', { name: 'Simulated drone position' });
    const lngStart = parseFloat(droneStart.getAttribute('data-longitude')!);

    // Block advances progress from 0.24 to 0.80 along segment 0
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));
    const droneBlocked = await screen.findByRole('img', { name: 'Simulated drone position' });
    const lngBlocked = parseFloat(droneBlocked.getAttribute('data-longitude')!);
    expect(lngBlocked).toBeGreaterThan(lngStart);

    // Clear and resume advances progress from 0.80 to 1.20 onto segment 1
    fireEvent.click(screen.getByRole('button', { name: 'Clear blockage' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'Resume' }));

    const droneResumed = await screen.findByRole('img', { name: 'Simulated drone position' });
    const lngResumed = parseFloat(droneResumed.getAttribute('data-longitude')!);
    expect(lngResumed).toBeGreaterThan(lngBlocked);
  });

  it('highlights corresponding geographic leg for blocked segment with native GeoJSON line and label', async () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    // Blocked indicator note
    const blockedOverlay = await screen.findByRole('note', { name: 'Blocked segment indicator' });
    expect(blockedOverlay).toBeTruthy();
    expect(blockedOverlay.textContent).toContain('WP 2 to WP 3');

    // Native MapLibre GeoJSON line source & layer for blocked segment
    const [map] = createdMaps();
    const source = map?.getSource('sim-blocked-segment');
    expect(source?.data).toMatchObject({
      type: 'FeatureCollection',
      features: expect.arrayContaining([
        expect.objectContaining({
          type: 'Feature',
          geometry: expect.objectContaining({ type: 'LineString' }),
        }),
      ]),
    });
    expect(map?.getLayer('sim-blocked-line')).toBeDefined();
  });

  it('preserves drone position when telemetry is dropped during hold and stays stable under camera changes', async () => {
    render(<MissionEditor />);
    startSimulation();
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    const markerBefore = await screen.findByRole('img', { name: 'Simulated drone position' });
    const posBefore = {
      lng: markerBefore.getAttribute('data-longitude'),
      lat: markerBefore.getAttribute('data-latitude'),
    };

    // Drop telemetry
    fireEvent.click(screen.getByRole('button', { name: 'Drop telemetry' }));
    const markerStale = await screen.findByRole('img', { name: 'Last known position' });
    expect(markerStale.getAttribute('data-longitude')).toBe(posBefore.lng);
    expect(markerStale.getAttribute('data-latitude')).toBe(posBefore.lat);

    // Pan camera
    const [map] = createdMaps();
    map?.easeTo({ center: [0, 0], duration: 100 });

    // Marker coordinate remains stable at the last reported geographic position
    expect(markerStale.getAttribute('data-longitude')).toBe(posBefore.lng);
    expect(markerStale.getAttribute('data-latitude')).toBe(posBefore.lat);
  });

  it('allows waypoint inspection during active simulation while edit lock is active', async () => {
    const draft = makeDraft({
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
      ],
    });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    // Load the draft
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    startSimulation();

    // Switch to edit tab during simulation
    goToEdit();

    // Route editing must be locked
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(true);

    // Waypoint markers exist in DOM — mandatory lookup (no if statement)
    const wp1 = await screen.findByRole('button', { name: 'Waypoint 1' });
    expect(wp1.getAttribute('aria-pressed')).toBe('false');

    // Clicking waypoint selects it for inspection without mutating draft
    fireEvent.click(wp1);
    expect(wp1.getAttribute('aria-pressed')).toBe('true');

    // End simulation restores editing
    goToSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
  });

  it('correctly labels blocked segment as WP 1 to WP 2 with a 2-point fixture', async () => {
    const draft = makeDraft({
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
      ],
    });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    startSimulation();

    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));

    const blockedOverlay = await screen.findByRole('note', { name: 'Blocked segment indicator' });
    expect(blockedOverlay.textContent).toBe('Blocked segment · WP 1 to WP 2');

    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toBe('Blocked segment · WP 1 to WP 2');
  });

  it('locks marker dragging during simulation and unlocks when simulation ends', async () => {
    const draft = makeDraft({
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
      ],
    });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const wp1 = await screen.findByRole('button', { name: 'Waypoint 1' });

    // Drag works before simulation (cursor is default/not locked)
    expect(wp1.style.cursor).toBe('');

    startSimulation();
    goToEdit();

    // During simulation, marker cursor indicates pointer (selection only, drag disabled)
    expect(wp1.style.cursor).toBe('pointer');

    // End simulation
    goToSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();
    // After simulation ends, drag is unlocked
    expect(wp1.style.cursor).toBe('');
  });
});

describe('pass 2 regressions: race conditions and sidebar selection', () => {
  it('cancels and retires in-flight assistant work at simulation Start; late reply after End does not appear or apply', async () => {
    const net = networkAgent();
    const draft = makeDraft({ height: '30' });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByRole('button', { name: 'Sign out' });

    // Send an assistant message
    const messageInput = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(messageInput, { target: { value: 'Raise height to 45m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(net.requests).toHaveLength(1));
    const [turn1] = net.requests;
    if (!turn1) throw new Error('Expected request');

    // Operator starts simulation while request is in flight
    startSimulation();

    // Verify in-flight request was aborted at Start
    expect(turn1.signal?.aborted).toBe(true);

    // Operator ends simulation
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    // Now return to Edit tab
    goToEdit();

    // Simulate late response resolving after simulation End
    await act(async () => {
      turn1.reply(jsonResponse(proposedResponse(turn1.request, 45)));
    });

    // Verify proposal does not appear in the UI
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('30');

    // Normal assistant workflow outside runs is preserved:
    // Send a new message after End
    fireEvent.change(messageInput, { target: { value: 'Set height to 50m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(net.requests).toHaveLength(2));
    const turn2 = net.requests[1];
    if (!turn2) throw new Error('Expected second request');

    await act(async () => {
      turn2.reply(jsonResponse(proposedResponse(turn2.request, 50)));
    });

    // Now proposal appears and can be applied!
    const applyButton = await screen.findByRole('button', { name: 'Apply proposed change' });
    expect(applyButton).toBeTruthy();
    fireEvent.click(applyButton);

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('50');
  });

  it('pauses composition without showing a pending request and ignores a reply during simulation', async () => {
    const net = networkAgent();
    seedLocalDraft(makeDraft({ height: '30' }), true);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByRole('button', { name: 'Sign out' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Raise height to 45m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(net.requests).toHaveLength(1));
    const [turn] = net.requests;
    if (!turn) throw new Error('Expected request');

    startSimulation();
    goToEdit();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
    expect(screen.queryByText('Starting assistant request.')).toBeNull();

    await act(async () => {
      turn.reply(jsonResponse(proposedResponse(turn.request, 45)));
    });
    expect(screen.queryByRole('button', { name: 'Apply proposed change' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('30');
  });

  it('invalidates async import started before simulation so it cannot apply after simulation ends', async () => {
    const originalDraft = makeDraft({ name: 'Original route', height: '30' });
    seedLocalDraft(originalDraft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Original route');

    // Start an async import with a deferred text promise
    const deferredText = deferred<string>();
    const file = new File([], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: () => deferredText.promise });

    const importInput = screen.getByLabelText('Import backup');
    fireEvent.change(importInput, { target: { files: [file] } });

    // While file.text() is pending, operator starts and ends simulation
    startSimulation();

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Original route');

    // Resolve the deferred import text after simulation ended
    const importedDraft = makeDraft({ name: 'Imported route from before sim', height: '80' });
    await act(async () => {
      deferredText.resolve(encodeBackup(importedDraft));
      await Promise.resolve();
    });

    // Verify imported route was NOT applied, no error shown
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Original route');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('30');
    expect(screen.queryByRole('alert')).toBeNull();

    // Normal import after simulation works as expected
    const afterSimDraft = makeDraft({ name: 'Imported route after sim', height: '65' });
    const afterFile = fileWithText('after.json', encodeBackup(afterSimDraft));
    await act(async () => {
      fireEvent.change(importInput, { target: { files: [afterFile] } });
      await Promise.resolve();
    });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Imported route after sim');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('65');
  });

  it('keeps WaypointList row selection inspectable during active simulation while actual controls are disabled', async () => {
    const draft = makeDraft({
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
        { id: '00000000-0000-4000-8000-000000000003', coordinate: { latitude: '37.7769', longitude: '-122.4174' } },
      ],
    });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    startSimulation();
    goToEdit();

    // Route settings are disabled
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff latitude' }).disabled).toBe(true);

    // Waypoint selection buttons in sidebar are enabled
    const selectWp1 = screen.getByRole('button', { name: 'Select waypoint 1' });
    const selectWp2 = screen.getByRole('button', { name: 'Select waypoint 2' });
    const selectWp3 = screen.getByRole('button', { name: 'Select waypoint 3' });
    expect(selectWp1.hasAttribute('disabled')).toBe(false);
    expect(selectWp2.hasAttribute('disabled')).toBe(false);
    expect(selectWp3.hasAttribute('disabled')).toBe(false);

    // Actual controls (reorder and delete) are disabled
    expect(screen.getByRole('button', { name: 'Reorder waypoint 1' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete waypoint 1' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reorder waypoint 2' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete waypoint 2' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reorder waypoint 3' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete waypoint 3' }).hasAttribute('disabled')).toBe(true);

    // Click waypoint 2 in sidebar to inspect it
    fireEvent.click(selectWp2);

    const rows = screen.getAllByRole('listitem');
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');

    // Selected waypoint section shows waypoint 2 coordinates, and inputs are disabled
    const selectedSection = screen.getByRole('region', { name: 'Selected waypoint' });
    expect(selectedSection.textContent).toContain('02');
    const selectedLat = within(selectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected latitude' });
    const selectedLng = within(selectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected longitude' });
    expect(selectedLat.value).toBe('37.7759');
    expect(selectedLng.value).toBe('-122.4184');
    expect(selectedLat.disabled).toBe(true);
    expect(selectedLng.disabled).toBe(true);

    // Select waypoint 3 using keyboard Enter on the row
    if (!rows[2]) throw new Error('Expected row 3');
    rows[2].focus();
    fireEvent.keyDown(rows[2], { key: 'Enter' });

    expect(rows[2].getAttribute('aria-current')).toBe('true');
    expect(selectedSection.textContent).toContain('03');
    expect(within(selectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected latitude' }).value).toBe('37.7769');
    expect(within(selectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected longitude' }).value).toBe('-122.4174');

    // End simulation restores reorder, delete, and coordinate editing
    goToSimulation();
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();

    expect(screen.getByRole('button', { name: 'Reorder waypoint 1' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete waypoint 1' }).hasAttribute('disabled')).toBe(false);
    const refreshedSelectedSection = screen.getByRole('region', { name: 'Selected waypoint' });
    expect(within(refreshedSelectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected latitude' }).disabled).toBe(false);
    expect(within(refreshedSelectedSection).getByRole<HTMLInputElement>('textbox', { name: 'Selected longitude' }).disabled).toBe(false);

    // Delete waypoint 1 works now
    fireEvent.click(screen.getByRole('button', { name: 'Delete waypoint 1' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('pass 3 regressions: route snapshot isolation, history retention, and restart', () => {
  it('retains run events and snapshot after End simulation until next Start', () => {
    const draft = makeDraft({ name: 'Quarry Survey', height: '35' });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    startSimulation();

    // Trigger lifecycle events
    fireEvent.click(screen.getByRole('button', { name: 'Block next segment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear blockage' }));
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'Resume' }));

    // End simulation
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    // Verify ended state displays retained route info and retained events
    expect(status.textContent).toContain('Simulation ended');
    expect(status.textContent).toContain('Quarry Survey');
    expect(status.textContent).toContain('35 m planned altitude');
    expect(status.textContent).toContain('2 waypoints');

    const eventList = within(status).getByRole('list');
    const items = within(eventList).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Simulation started',
      'Next segment blocked',
      'Autopilot commanded hold',
      'Telemetry confirmed hold',
      'Blockage cleared',
      'Operator resumed the route',
      'Simulation ended',
    ]);
  });

  it('isolates ended run snapshot and history from draft mutations on Edit tab until next Start', () => {
    const draft = makeDraft({ name: 'Original Survey', height: '30', points: [
      ...makeDraft().points,
      { id: '00000000-0000-4000-8000-000000000003', coordinate: { latitude: '37.7769', longitude: '-122.4174' } },
    ] });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    startSimulation();

    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    // Switch to Edit tab and mutate the draft
    goToEdit();
    const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    expect(nameInput.disabled).toBe(false);
    fireEvent.change(nameInput, { target: { value: 'Mutated Route' } });
    const heightInput = screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' });
    fireEvent.change(heightInput, { target: { value: '55' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete waypoint 3' }));

    // Switch back to Simulation tab: re-query inspector panel since Edit tab unmounted it
    goToSimulation();
    const simPanel = screen.getByRole('region', { name: 'Simulation inspector' });
    const simStatus = within(simPanel).getByRole('region', { name: 'Simulation status' });
    expect(simStatus.textContent).toContain('Simulation ended');
    const nextRoute = within(simStatus).getByRole('group', { name: 'Route to simulate' });
    const previousRun = within(simStatus).getByRole('group', { name: 'Previous run' });
    expect(nextRoute.textContent).toContain('Mutated Route');
    expect(nextRoute.textContent).toContain('55 m planned altitude');
    expect(previousRun.textContent).toContain('Original Survey');
    expect(previousRun.textContent).toContain('3 waypoints · 30 m planned altitude');
    expect(nextRoute.textContent).toContain('2 waypoints');
    expect(screen.getByLabelText('Map legend').textContent).toBe('Planned route · 2 waypoints');

    // Click Start simulation: now a fresh snapshot is captured from the mutated draft, and events reset
    fireEvent.click(within(simStatus).getByRole('button', { name: 'Start simulation' }));

    expect(simStatus.textContent).toContain('Running');
    expect(simStatus.textContent).toContain('55 m');
    const eventList = within(simStatus).getByRole('list');
    const items = within(eventList).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Simulation started']);
  });

  it('binds active map and panel to the same captured route snapshot and unlocks editing after End', async () => {
    const draft = makeDraft({
      name: 'Snapshot Map Test',
      height: '40',
      points: [
        { id: '00000000-0000-4000-8000-000000000001', coordinate: { latitude: '37.7749', longitude: '-122.4194' } },
        { id: '00000000-0000-4000-8000-000000000002', coordinate: { latitude: '37.7759', longitude: '-122.4184' } },
      ],
    });
    seedLocalDraft(draft, true);

    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    startSimulation();

    // Map overlay legend reflects active snapshot route
    const legend = screen.getByLabelText('Map legend');
    expect(legend.textContent).toBe('Simulated drone · Planned route');

    // Drone marker is rendered at the snapshot start coordinate
    const drone = await screen.findByRole('img', { name: 'Simulated drone position' });
    expect(drone).toBeTruthy();
    const startLng = parseFloat(drone.getAttribute('data-longitude')!);
    expect(startLng).toBeCloseTo(-122.4194 + 0.001 * 0.24, 4);

    // End simulation unlocks editing
    const panel = screen.getByRole('region', { name: 'Simulation inspector' });
    const status = within(panel).getByRole('region', { name: 'Simulation status' });
    fireEvent.click(within(status).getByRole('button', { name: 'End simulation' }));

    goToEdit();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });
});
