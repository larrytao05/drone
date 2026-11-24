import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { importDraft, isMapTilerSatelliteTile, openBlankEditor } from './editor-helpers.js';

const liveProviders = process.env.SIMULATION_LIVE_PROVIDERS === '1';

async function verifyAgentReply(page: Page) {
  await page.getByLabel('Assistant password').fill('simulation-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(
    'How many waypoints are in this draft? Answer in one sentence without changing the route.',
  );
  const reply = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/agent' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await reply).status()).toBe(200);
  const conversation = page.getByRole('list', { name: 'Assistant conversation' });
  await expect(conversation.getByRole('listitem').filter({
    has: page.getByText('Assistant', { exact: true }),
  }).locator('p')).toHaveText(/\S/);
}

test('real browser-to-bridge-to-isolated-PX4 multi-leg journey: launch, 90-degree turn, hold on leg 2, clear, reload recovery, resume, final waypoint completion, end cleanup and draft editing', async ({ page }) => {
  let imageryTiles = 0;
  if (liveProviders) {
    page.on('response', (response) => {
      if (isMapTilerSatelliteTile(response.url()) && response.ok()) {
        imageryTiles += 1;
      }
    });
  }

  // Step 1: Open Blank Editor and verify local map & simulation readiness
  await openBlankEditor(page);
  await expect(page.getByRole('status', { name: 'Map status' })).toContainText('Map ready');

  await page.getByRole('button', { name: 'Simulation' }).click();
  const simPanel = page.getByRole('region', { name: 'Simulation inspector' });
  await expect(simPanel).toContainText('Isolated PX4 simulator');
  await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Ready to simulate');

  // Step 2: Validate editor route before launch and reject unsupported input with clear error
  await simPanel.getByRole('button', { name: 'Start simulation' }).click();
  await expect(simPanel.getByRole('alert')).toContainText(
    'Route must be fully calculated before starting simulation.',
  );
  expect(await page.request.get('/api/simulation').then((response) => response.json())).toMatchObject({ status: { runId: null, cleanupCompleted: true } });

  // Step 3: Import 4-waypoint multi-leg route and verify matching route summary in UI
  await page.getByRole('button', { name: 'Edit' }).click();
  const fixture = JSON.parse(readFileSync('public/fixtures/multi-leg-route.json', 'utf8')) as {
    draft: { name: string; [key: string]: unknown };
  };
  await importDraft(page, fixture.draft);
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(fixture.draft.name);

  if (liveProviders) {
    await expect.poll(() => imageryTiles, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText(/MapTiler/i);
    await verifyAgentReply(page);
  }

  await page.getByRole('button', { name: 'Simulation' }).click();
  await expect(simPanel).toContainText(fixture.draft.name);
  await expect(simPanel).toContainText('4 waypoints · 10 m planned altitude');

  // Step 4: Launch validated route to live simulator bridge
  const startResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/simulation') &&
    response.request().method() === 'POST' &&
    response.request().postDataJSON().action === 'start');
  let runId: string | undefined;
  try {
    await simPanel.getByRole('button', { name: 'Start simulation' }).click();
    const started = await (await startResponse).json();
    runId = started.status?.runId;
    expect(runId).toMatch(/^sim_[a-z0-9_]+$/);
    expect(started.status.route).toMatchObject({ name: fixture.draft.name });
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Starting simulation');
    await expect(simPanel).toContainText('Initializing simulator and preflight health.');

    // Check that Edit tab is locked during active simulation
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Simulation running · Route editing paused.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Route name' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByRole('button', { name: 'Back to Simulation' }).click();

    // Step 5: Wait for Preflight and Real Map Marker Motion on Leg 1 (Northward)
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Running', {
      timeout: 60_000,
    });
    await expect(simPanel).toContainText('Route motion confirmed', { timeout: 25_000 });

    const altDd = simPanel.locator('dt:has-text("Altitude") + dd');
    await expect(altDd).toContainText('m');
    const altValue = parseFloat((await altDd.textContent()) ?? '0');
    expect(altValue).toBeGreaterThan(5);
    expect(altValue).toBeLessThan(15);

    const droneMarker = page.locator('[aria-label="Simulated drone position"]');
    await expect(droneMarker).toBeVisible();

    // Verify real geographic marker progress northward from takeoff position (47.397743)
    const takeoffLat = 47.397743;
    const takeoffLon = 8.545594;
    await expect
      .poll(async () => parseFloat((await droneMarker.getAttribute('data-latitude')) ?? '0'), {
        timeout: 25_000,
      })
      .toBeGreaterThan(takeoffLat + 0.00005);

    // Verify active leg on leg 1
    await expect(simPanel.locator('dt:has-text("Active leg") + dd')).toContainText(/Leg 1|WP 1/i);

    // Step 6: 90° turn East onto Leg 2 and Hold before blockage
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Holding', {
      timeout: 45_000,
    });
    await expect(simPanel).toContainText('Telemetry confirmed hold');
    await expect(simPanel.locator('dt:has-text("Active leg") + dd')).toContainText(/Leg 2|WP 2/i);
    await expect(simPanel.locator('dt:has-text("Blocked leg") + dd')).toContainText(/Leg 2|WP 2/i);

    // Verify eastward displacement from turn onto Leg 2
    await expect
      .poll(async () => parseFloat((await droneMarker.getAttribute('data-longitude')) ?? '0'), {
        timeout: 10_000,
      })
      .toBeGreaterThan(takeoffLon + 0.00005);

    const resumeBtn = simPanel.getByRole('button', { name: 'Resume' });
    const endBtn = simPanel.getByRole('button', { name: 'End simulation' });
    await expect(endBtn).toBeEnabled();

    // Step 7: Blockage clearance & continued hold
    await expect(simPanel).toContainText('Blockage cleared', { timeout: 15_000 });
    await expect(simPanel).toContainText('Segment clear. Waiting for you to resume.');
    await expect(resumeBtn).toBeEnabled();

    // Verify continued hold post-clearance (no autonomous resume)
    await page.waitForTimeout(2500);
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Holding');

    // Step 8: Exercise stale polling/recovery without fabricating success status
    await page.route('**/api/simulation?runId=*', (route) => route.abort());
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Telemetry unavailable', {
      timeout: 5_000,
    });
    await expect(simPanel).toContainText('Resume requires fresh telemetry.');
    await expect(resumeBtn).toBeDisabled();
    await expect(endBtn).toBeEnabled();
    const staleMarker = page.locator('[aria-label^="Last known position"]');
    await expect(staleMarker).toBeVisible();

    // Edit lock remains during polling failure
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('textbox', { name: 'Route name' })).toBeDisabled();
    await page.getByRole('button', { name: 'Back to Simulation' }).click();

    // Restore network polling and verify recovery
    await page.unroute('**/api/simulation?runId=*');
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Holding', {
      timeout: 5_000,
    });
    await expect(simPanel).toContainText('Segment clear. Waiting for you to resume.');
    await expect(resumeBtn).toBeEnabled();

    // Step 9: Reload recovery (recover active holding run, telemetry, events, active/blocked legs, and edit lock)
    await page.reload();
    await expect(page.getByText('Simulation running · Route editing paused.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('textbox', { name: 'Route name' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Verify matching route and run identity across reload
    const reloadedStatus = await page.request.get('/api/simulation').then((response) => response.json());
    expect(reloadedStatus.status?.runId).toBe(runId);
    expect(reloadedStatus.status?.route?.name).toBe(fixture.draft.name);

    // Switch to Simulation tab and verify state recovered
    await page.getByRole('button', { name: 'Back to Simulation' }).click();
    const recoveredPanel = page.getByRole('region', { name: 'Simulation inspector' });
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Holding');
    await expect(recoveredPanel).toContainText('Segment clear. Waiting for you to resume.');
    await expect(recoveredPanel.locator('dt:has-text("Blocked leg") + dd')).toContainText(/Leg 2|WP 2/i);
    const recoveredResumeBtn = recoveredPanel.getByRole('button', { name: 'Resume' });
    const recoveredEndBtn = recoveredPanel.getByRole('button', { name: 'End simulation' });
    await expect(recoveredResumeBtn).toBeEnabled();
    await expect(recoveredEndBtn).toBeEnabled();

    const resumedMarker = page.locator('[aria-label="Simulated drone position"]');
    await expect(resumedMarker).toBeVisible();
    const lonBeforeResume = parseFloat((await resumedMarker.getAttribute('data-longitude')) ?? '0');
    expect(lonBeforeResume).toBeGreaterThan(takeoffLon + 0.00005);

    // Step 10: Explicit Resume and resumed motion eastward along Leg 2
    await recoveredResumeBtn.click();
    await expect(recoveredPanel).toContainText('Route motion resumed', { timeout: 20_000 });
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Running');

    await expect
      .poll(async () => parseFloat((await resumedMarker.getAttribute('data-longitude')) ?? '0'), {
        timeout: 15_000,
      })
      .toBeGreaterThan(lonBeforeResume);

    // Step 11: 90° turn South onto Leg 3, navigation to final waypoint WP 4, and terminal Mission Completion
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Mission completed', {
      timeout: 50_000,
    });
    await expect(recoveredPanel).toContainText('Reached final waypoint. Ready for teardown.');
    await expect(recoveredPanel.locator('dt:has-text("Active leg") + dd')).toContainText(/Final waypoint reached/i);
    await expect(recoveredEndBtn).toBeEnabled();

    // Step 12: End simulation, verify container cleanup and enable actual draft edit
    await recoveredEndBtn.click();
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Simulation ended', {
      timeout: 25_000,
    });

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Simulation running · Route editing paused.')).toHaveCount(0);

    const routeNameInput = page.getByRole('textbox', { name: 'Route name' });
    await expect(routeNameInput).toBeEnabled();
    await routeNameInput.fill('Edited route after multi-leg simulation');
    await expect(routeNameInput).toHaveValue('Edited route after multi-leg simulation');

    const ended = await page.request.get('/api/simulation').then((response) => response.json());
    expect(ended).toMatchObject({ status: { runId, cleanupCompleted: true } });
    const containers = execFileSync('docker', ['ps', '-a', '-q', '--filter', `name=sim1_${runId}_`], { encoding: 'utf8' }).trim();
    expect(containers).toBe('');
  } finally {
    if (runId) {
      await page.request.post('/api/simulation', {
        headers: { origin: new URL(page.url()).origin },
        data: { action: 'end', runId },
      });
    }
  }
});
