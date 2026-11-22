import { expect, test, type Page, type Route } from '@playwright/test';
import { agentRequestSchema, agentSessionRequestSchema, type AgentRequest, type AgentResponse } from '../../src/agent-contract.js';
import { draftFixture, importDraft, openBlankEditor } from './editor-helpers.js';

type PendingTurn = Readonly<{ request: AgentRequest; route: Route }>;
async function fakeAgent(page: Page, unavailable = false) {
  let authenticated = false;
  const turns: PendingTurn[] = [];
  const sessions: string[] = [];
  await page.route('**/api/agent/session', async (route) => {
    const action = agentSessionRequestSchema.parse(route.request().postDataJSON());
    sessions.push(action.action);
    if (unavailable) { await route.fulfill({ status: 503, json: {} }); return; }
    if (action.action === 'logout') authenticated = false;
    if (action.action === 'login') {
      if (action.password !== 'route-password') { await route.fulfill({ status: 401, json: {} }); return; }
      authenticated = true;
    }
    await route.fulfill({ json: authenticated
      ? { authenticated: true, epoch: 'a'.repeat(32), serverNow: 1_800_000_000_000, retryWindowMs: 120_000 }
      : { authenticated: false } });
  });
  await page.route('**/api/agent', (route) => {
    turns.push({ route, request: agentRequestSchema.parse(route.request().postDataJSON()) });
  });
  return { turns, sessions };
}
async function signIn(page: Page) {
  await page.getByLabel('Assistant password').fill('route-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function openChat(page: Page, draft: { name: string } = draftFixture()) {
  const net = await fakeAgent(page);
  await openBlankEditor(page);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await importDraft(page, draft);
  await signIn(page);
  return net;
}
async function send(page: Page, net: Awaited<ReturnType<typeof fakeAgent>>, message = 'Raise the height') {
  const index = net.turns.length;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => net.turns.length).toBe(index + 1);
  const turn = net.turns[index];
  if (!turn) throw new Error('Expected a request');
  return turn;
}
function proposal(turn: PendingTurn, height = 40): AgentResponse {
  return { requestId: turn.request.requestId, binding: turn.request.binding, outcome: { kind: 'proposed', change: { kind: 'set-height', heightAboveTakeoffM: height }, activity: [] } };
}
async function reply(turn: PendingTurn, response = proposal(turn)) {
  await turn.route.fulfill({ json: response });
}
const heightInput = (page: Page) => page.getByRole('textbox', { name: 'Height above takeoff' });
const apply = (page: Page) => page.getByRole('button', { name: 'Apply proposed change' });

test('valid route without takeoff signs in, sends, previews and applies only the selected change', async ({ page }) => {
  const draft = draftFixture({ takeoff: null, height: '030.0' });
  const net = await openChat(page, draft);
  const beforeStorage = await page.evaluate(() => ({ ...localStorage }));
  const turn = await send(page, net);
  expect(turn.request.snapshot.heightAboveTakeoffM).toBe(30);
  await reply(turn);
  await expect(page.getByRole('table', { name: 'Waypoint height and camera pitch comparison' })).toBeVisible();
  await expect(heightInput(page)).toHaveValue('030.0');
  await apply(page).click();
  await expect(heightInput(page)).toHaveValue('40');
  await expect(apply(page)).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText('Not reviewed');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(beforeStorage);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Mark as reviewed' })).toBeDisabled();
});

test('Dismiss preserves source and manual edits keep a stale proposal visible even for invalid source', async ({ page }) => {
  const net = await openChat(page);
  await reply(await send(page, net));
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(heightInput(page)).toHaveValue('30');
  await expect(apply(page)).toHaveCount(0);
  await reply(await send(page, net, 'Raise again'));
  await expect(apply(page)).toBeEnabled();
  await heightInput(page).fill('31');
  await expect(apply(page)).toBeDisabled();
  await expect(page.getByText(/proposal is out of date/)).toBeVisible();
  await heightInput(page).fill('-');
  await expect(page.getByText(/Complete the waypoint coordinates, height and framing/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(apply(page)).toBeDisabled();
});

for (const replacement of ['New', 'Load', 'Import'] as const) {
  test(`late reply after ${replacement} cannot restore conversation or proposal`, async ({ page }) => {
    const net = await openChat(page);
    if (replacement === 'Load') {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    }
    const turn = await send(page, net, 'Retired message');
    if (replacement === 'Import') await importDraft(page, draftFixture({ name: 'Replacement route', height: '32' }));
    else await page.getByRole('button', { name: replacement, exact: true }).click();
    await reply(turn);
    await expect(page.getByRole('list', { name: 'Assistant conversation' })).toHaveCount(0);
    await expect(apply(page)).toHaveCount(0);
    await expect(heightInput(page)).toHaveValue(replacement === 'New' ? '' : replacement === 'Import' ? '32' : '30');
  });
}

test('Cancel and pending source edits reject delayed responses and allow a new user turn', async ({ page }) => {
  const net = await openChat(page);
  const cancelled = await send(page, net, 'Cancelled message');
  await page.getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.getByText(/Stopped waiting for this request/)).toBeVisible();
  const edited = await send(page, net, 'Retired by editing');
  await heightInput(page).fill('33');
  const current = await send(page, net, 'Current message');
  await reply(current, proposal(current, 43));
  await reply(edited, proposal(edited, 44));
  await reply(cancelled, proposal(cancelled, 45));
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect(heightInput(page)).toHaveValue('43');
});

test('denied login, logout, re-login and session expiry are usable and clear proposals', async ({ page }) => {
  const net = await fakeAgent(page);
  await openBlankEditor(page);
  await importDraft(page, draftFixture());
  await page.getByLabel('Assistant password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Sign-in failed/)).toBeVisible();
  await signIn(page);
  await reply(await send(page, net));
  await expect(apply(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(apply(page)).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Assistant conversation' })).toHaveCount(0);
  expect(net.sessions).toContain('logout');
  await signIn(page);
  const expired = await send(page, net);
  await expired.route.fulfill({ status: 401, json: {} });
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Assistant conversation' })).toHaveCount(0);
  await expect(heightInput(page)).toHaveValue('30');
});

test('unavailable authentication leaves manual source editing usable', async ({ page }) => {
  await fakeAgent(page, true);
  await openBlankEditor(page);
  await expect(page.getByText(/Sign-in is unavailable/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Route name' }).fill('Manual route');
  await heightInput(page).fill('25');
  await expect(heightInput(page)).toHaveValue('25');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('wrong binding is rejected and provider failure offers only an explicit immutable retry', async ({ page }) => {
  const net = await openChat(page);
  const wrong = await send(page, net);
  const response = proposal(wrong);
  await reply(wrong, { ...response, binding: { ...response.binding, missionBranchId: 'another-route' } });
  await expect(page.getByText(/response could not be verified/)).toBeVisible();
  await expect(apply(page)).toHaveCount(0);
  const failed = await send(page, net, 'Try current route');
  await failed.route.fulfill({ status: 503, json: {} });
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  expect(net.turns).toHaveLength(2);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect.poll(() => net.turns.length).toBe(3);
  const retried = net.turns[2]; if (!retried) throw new Error('Expected explicit retry');
  expect(retried.request).toEqual(failed.request);
  expect(retried.route.request().postData()).toBe(failed.route.request().postData());
  await reply(retried);
  await expect(apply(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const terminal = await send(page, net, 'Another message');
  await reply(terminal, { requestId: terminal.request.requestId, binding: terminal.request.binding, outcome: { kind: 'failed', activity: [] } });
  await expect(page.getByText(/could not complete this request/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0);
});

test('live model stage and safe provider failure remain reviewable', async ({ page }) => {
  const net = await openChat(page);
  await page.route('**/api/agent/progress', async (route) => {
    const { requestId, binding } = route.request().postDataJSON();
    await route.fulfill({ json: {
      requestId, binding, state: 'running', elapsedMs: 1_200,
      events: [{ kind: 'model-start', elapsedMs: 100 }],
    } });
  });
  const turn = await send(page, net, 'Raise the route height');
  await expect(page.getByRole('status', { name: 'Assistant request status' })).toHaveText('Waiting for model response');
  await expect(page.getByText(/Elapsed \d+ seconds/)).toBeVisible();
  await page.getByText('Request details').click();
  await expect(page.getByRole('list', { name: 'Assistant activity' })).toContainText('Waiting for model response');
  await turn.route.fulfill({ status: 502, json: {
    requestId: turn.request.requestId, binding: turn.request.binding,
    outcome: { kind: 'failed', activity: [], diagnostic: { code: 'provider-rate-limit', status: 429 } },
  } });
  await expect(page.getByRole('status', { name: 'Assistant request status' })).toContainText('model provider is limiting requests');
  await expect(page.getByText('Diagnosis:')).toContainText('provider-rate-limit');
  await expect(page.getByText('Diagnosis:')).toContainText('Provider status: 429');
  await expect(page.getByText(/Duration: \d+\.\d seconds/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/drone-agent-observability.png', fullPage: true });
});

test('a no-op preserves raw formatting, review and saved source; a pending save remains explicit', async ({ page }) => {
  const net = await openChat(page, draftFixture({ height: '030.0' }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Mark as reviewed' }).check();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const storage = await page.evaluate(() => ({ ...localStorage }));
  const noop = await send(page, net);
  await reply(noop, proposal(noop, 30));
  await expect(page.getByText(/preserve the current formatting/)).toBeVisible();
  await apply(page).click();
  await expect(heightInput(page)).toHaveValue('030.0');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText('Reviewed');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(storage);
  const turn = await send(page, net, 'Raise to forty');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await reply(turn);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await apply(page).click();
  await expect(heightInput(page)).toHaveValue('40');
  await expect(page.getByRole('status', { name: 'Review status' })).toHaveText('Not reviewed');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(storage);
});

for (const view of [{ name: 'desktop', width: 1440, dark: false }, { name: '320', width: 320, dark: false }, { name: 'dark', width: 1440, dark: true }]) {
  test(`mission assistant ${view.name} layout, keyboard focus and bounded comparison`, async ({ page }) => {
    await page.setViewportSize({ width: view.width, height: 1000 });
    await page.emulateMedia({ colorScheme: view.dark ? 'dark' : 'light' });
    const net = await openChat(page, draftFixture({ framing: { kind: 'face-target', coordinate: { latitude: '37.776', longitude: '-122.417' }, height: '4' } }));
    const turn = await send(page, net, 'Raise route height to forty metres');
    await reply(turn);
    const comparison = page.getByRole('region', { name: 'Scroll waypoint comparison horizontally' });
    await expect(comparison).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(comparison).toBeFocused();
    expect(await comparison.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
    if (view.width === 320) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => comparison.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/drone-stage3-run/issue20-${view.name}.png`, fullPage: true });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(apply(page)).toBeFocused();
    await page.screenshot({ path: `/tmp/drone-stage3-run/issue20-${view.name}-focus.png`, fullPage: true });
    await heightInput(page).fill('-');
    await expect(apply(page)).toBeDisabled();
    await page.screenshot({ path: `/tmp/drone-stage3-run/issue20-${view.name}-stale.png`, fullPage: true });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await heightInput(page).fill('030.0');
    const noop = await send(page, net, 'Keep the height at thirty');
    await reply(noop, proposal(noop, 30));
    await expect(page.getByText(/preserve the current formatting/)).toBeVisible();
    await page.screenshot({ path: `/tmp/drone-stage3-run/issue20-${view.name}-noop.png`, fullPage: true });
  });
}


test('Clear conversation retires a pending reply and plaintext answers remain inert', async ({ page }) => {
  const net = await openChat(page);
  const old = await send(page, net, 'Discard this text');
  await page.getByRole('button', { name: 'Clear conversation' }).click();
  await reply(old);
  await expect(page.getByRole('list', { name: 'Assistant conversation' })).toHaveCount(0);
  await expect(apply(page)).toHaveCount(0);
  const turn = await send(page, net, '<b>user text</b>');
  expect(turn.request.history).toEqual([]);
  await reply(turn, { requestId: turn.request.requestId, binding: turn.request.binding, outcome: { kind: 'answered', text: '<img src=x onerror=alert(1)>', activity: [] } });
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(heightInput(page)).toHaveValue('30');
});
