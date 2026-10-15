import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MissionEditor } from '../../web/MissionEditor.js';
import { makeDraft } from './fixtures.js';
import { encodeBackup, readLocalDraft, writeLocalDraft } from '../../web/draft-storage.js';
import type { MissionDraft } from '../../web/editor.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => {
  const originalCreateElement = document.createElement.bind(document);
  function createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, options?: ElementCreationOptions): HTMLElementTagNameMap[K];
  function createElement(tagName: string, options?: ElementCreationOptions): HTMLElement;
  function createElement(tagName: string, options?: ElementCreationOptions): HTMLElement {
    const element = originalCreateElement(tagName, options);
    if (tagName.toLowerCase() === 'dialog') {
      Object.defineProperty(element, 'showModal', {
        configurable: true,
        value: () => element.setAttribute('open', ''),
      });
      Object.defineProperty(element, 'close', {
        configurable: true,
        value: () => {
          element.removeAttribute('open');
          element.dispatchEvent(new Event('close'));
        },
      });
    }
    return element;
  }
  vi.spyOn(document, 'createElement').mockImplementation(createElement);
});

function seedDraft(draft: MissionDraft, reviewed: boolean) {
  expect(writeLocalDraft({ storage: window.localStorage, draft, reviewed })).toEqual({ kind: 'success' });
}

function fileWithText(name: string, text: string | (() => Promise<string>)): File {
  const file = new File([typeof text === 'string' ? text : ''], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    value: typeof text === 'string' ? () => Promise.resolve(text) : text,
  });
  return file;
}

async function openSave() {
  await screen.findByRole('status', { name: 'Draft storage status' });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  return screen.findByRole('dialog');
}

describe('review and save transaction', () => {
  it.each([
    ['invalid', makeDraft({ takeoff: { latitude: '91', longitude: '-122.4200' } }), 'Enter a value between -90 and 90.'],
    ['missing', makeDraft({ takeoff: null }), 'Set a takeoff coordinate before reviewing.'],
  ] as const)('explains %s takeoff while retaining the calculated route', async (_kind, draft, expectedIssue) => {
    seedDraft(draft, false);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const dialog = await openSave();

    expect(within(dialog).getByRole('table', { name: 'Calculated waypoints' })).toBeTruthy();
    const takeoffIssues = within(dialog).getByRole('region', { name: 'Takeoff requirements' });
    expect(takeoffIssues.textContent).toMatch(/takeoff/i);
    expect(takeoffIssues.textContent).toContain(expectedIssue);
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Mark as reviewed' }).disabled).toBe(true);
  });

  it('opens checked for reviewed work and cancel preserves review, source and baseline', async () => {
    const source = makeDraft();
    seedDraft(source, true);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const dialog = await openSave();

    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Mark as reviewed' }).checked).toBe(true);
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe(source.name);
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');
    expect(writes).not.toHaveBeenCalled();
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft: source, reviewed: true });
  });

  it('opens unchecked for unreviewed work and cancel leaves review unchanged', async () => {
    seedDraft(makeDraft({ name: 'Unreviewed' }), false);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const reviewedDialog = await openSave();
    expect(within(reviewedDialog).getByRole<HTMLInputElement>('checkbox', { name: 'Mark as reviewed' }).checked).toBe(false);
    fireEvent.click(within(reviewedDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Not reviewed');
  });

  it('permits an incomplete draft to save unreviewed', async () => {
    render(<MissionEditor />);
    const incompleteDialog = await openSave();
    const checkbox = within(incompleteDialog).getByRole<HTMLInputElement>('checkbox', { name: 'Mark as reviewed' });
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(within(incompleteDialog).getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByRole('status', { name: 'Save status' })).textContent).toContain('Saved');
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toContain('Not reviewed');
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft: { name: '', points: [], height: '', framing: { kind: 'unselected' }, takeoff: null }, reviewed: false });
  });

  it('keeps the dialog open and preserves source and baseline when a write fails', async () => {
    const baseline = makeDraft({ name: 'Saved baseline' });
    seedDraft(baseline, false);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const routeName = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(routeName, { target: { value: 'Current work' } });
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage full', 'QuotaExceededError');
    });
    const dialog = await openSave();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('The draft was not saved');
    expect(routeName.value).toBe('Current work');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Unsaved');
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Not reviewed');
    expect(writes).toHaveBeenCalledTimes(1);
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft: baseline, reviewed: false });
  });

  it('keeps the dialog open when localStorage cannot be acquired', async () => {
    render(<MissionEditor />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Route name' }), { target: { value: 'Current work' } });
    const dialog = await openSave();
    const storage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('storage blocked', 'SecurityError');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('storage blocked');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Current work');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toContain('Unsaved');
    expect(storage).toHaveBeenCalled();
  });

  it('refreshes a stale snapshot and writes nothing until the refreshed source is confirmed', async () => {
    const baseline = makeDraft({ name: 'Saved baseline' });
    seedDraft(baseline, false);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    let finishRead: (text: string) => void = () => undefined;
    const incoming = makeDraft({ name: 'Source changed during review', height: '40' });
    fireEvent.change(screen.getByLabelText('Import backup'), {
      target: { files: [fileWithText('delayed.json', () => new Promise((resolve) => { finishRead = resolve; }))] },
    });
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const dialog = await openSave();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mark as reviewed' }));
    finishRead(encodeBackup(incoming));

    expect(await screen.findByDisplayValue(incoming.name)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    const refreshedDialog = screen.getByRole('dialog');
    expect(refreshedDialog).toBeTruthy();
    expect(within(refreshedDialog).getByText(incoming.name)).toBeTruthy();
    const refreshedTable = within(refreshedDialog).getByRole('table', { name: 'Calculated waypoints' });
    expect(within(refreshedTable).getAllByRole('cell', { name: '40' })).toHaveLength(2);
    expect(within(refreshedDialog).getByRole<HTMLInputElement>('checkbox', { name: 'Mark as reviewed' }).checked).toBe(false);
    expect(within(refreshedDialog).getByRole('alert').textContent).toContain('route changed');
    expect(writes).not.toHaveBeenCalled();
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft: baseline, reviewed: false });

    fireEvent.click(within(refreshedDialog).getByRole('button', { name: 'Confirm' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe(incoming.name);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft: incoming, reviewed: false });
  });

  it('writes once when Confirm is activated twice', async () => {
    render(<MissionEditor />);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const dialog = await openSave();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(writes).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('status', { name: 'Save status' })).textContent).toContain('Saved');
  });
});
