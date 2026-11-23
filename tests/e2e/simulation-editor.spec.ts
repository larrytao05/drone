import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { importDraft, openBlankEditor } from './editor-helpers.js';

test('real browser-to-bridge-to-isolated-PX4 journey: launch, map marker motion, hold, clear, reload recovery, resume, end cleanup and draft editing', async ({ page }) => {
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

  // Step 3: Import synthetic route and verify matching route summary in UI
  await page.getByRole('button', { name: 'Edit' }).click();
  const fixture = JSON.parse(readFileSync('public/fixtures/eastbound-route.json', 'utf8')) as {
    draft: { name: string; [key: string]: unknown };
  };
  await importDraft(page, fixture.draft);
  await expect(page.getByRole('textbox', { name: 'Route name' })).toHaveValue(fixture.draft.name);

  await page.getByRole('button', { name: 'Simulation' }).click();
  await expect(simPanel).toContainText(fixture.draft.name);
  await expect(simPanel).toContainText('3 waypoints · 10 m planned altitude');

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

    // Step 5: Wait for Preflight and Real Map Marker Motion
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

    // Verify real geographic marker progress eastward from takeoff position (8.545594)
    const takeoffLon = 8.545594;
    await expect
      .poll(async () => parseFloat((await droneMarker.getAttribute('data-longitude')) ?? '0'), {
        timeout: 25_000,
      })
      .toBeGreaterThan(takeoffLon + 0.00005);

    // Step 6: Hold before blockage
    await expect(simPanel.getByRole('heading', { level: 2 })).toHaveText('Holding', {
      timeout: 25_000,
    });
    await expect(simPanel).toContainText('Telemetry confirmed hold');
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

    // Step 8: Exercise stale polling/recovery where practical without fabricating success status
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

    // Step 9: Reload recovery (recover active holding run, telemetry, events, and edit lock)
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
    const recoveredResumeBtn = recoveredPanel.getByRole('button', { name: 'Resume' });
    const recoveredEndBtn = recoveredPanel.getByRole('button', { name: 'End simulation' });
    await expect(recoveredResumeBtn).toBeEnabled();
    await expect(recoveredEndBtn).toBeEnabled();

    const resumedMarker = page.locator('[aria-label="Simulated drone position"]');
    await expect(resumedMarker).toBeVisible();
    const lonBeforeResume = parseFloat((await resumedMarker.getAttribute('data-longitude')) ?? '0');
    expect(lonBeforeResume).toBeGreaterThan(takeoffLon + 0.00005);

    // Step 10: Explicit Resume and resumed motion eastward
    await recoveredResumeBtn.click();
    await expect(recoveredPanel).toContainText('Route motion resumed', { timeout: 20_000 });
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Running');

    await expect
      .poll(async () => parseFloat((await resumedMarker.getAttribute('data-longitude')) ?? '0'), {
        timeout: 15_000,
      })
      .toBeGreaterThan(lonBeforeResume);

    // Step 11: End simulation, verify cleanup and enable actual draft edit
    await recoveredEndBtn.click();
    await expect(recoveredPanel.getByRole('heading', { level: 2 })).toHaveText('Simulation ended', {
      timeout: 25_000,
    });

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Simulation running · Route editing paused.')).toHaveCount(0);

    const routeNameInput = page.getByRole('textbox', { name: 'Route name' });
    await expect(routeNameInput).toBeEnabled();
    await routeNameInput.fill('Edited route after simulation');
    await expect(routeNameInput).toHaveValue('Edited route after simulation');

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
