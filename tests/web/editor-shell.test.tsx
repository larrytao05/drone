import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Dispatch } from 'react';
import { Inspector } from '../../web/Inspector.js';
import { MissionEditor } from '../../web/MissionEditor.js';
import { analyseDraft } from '../../web/mission-input.js';
import { createEditorState, type EditorAction, type EditorState, type MissionDraft } from '../../web/editor.js';
import { makeDraft } from './fixtures.js';
import { encodeBackup, readLocalDraft, writeLocalDraft } from '../../web/draft-storage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function seedLocalDraft(draft: MissionDraft, reviewed: boolean) {
  expect(writeLocalDraft({ storage: window.localStorage, draft, reviewed })).toEqual({ kind: 'success' });
}

function fileWithText(name: string, text: string | (() => Promise<string>)): File {
  const file = new File([typeof text === 'string' ? text : ''], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    value: typeof text === 'string' ? () => Promise.resolve(text) : text,
  });
  return file;
}

function expectText(element: HTMLElement, text: string) {
  expect(element.textContent).toContain(text);
}

function stateWithPoints(count: number, selectedIndex: number | null = null): EditorState {
  const points = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    coordinate: { latitude: String(37 + index / 1000), longitude: String(-122 - index / 1000) },
  }));
  const draft = {
    name: 'Harbor survey',
    points,
    height: '32',
    framing: { kind: 'fixed', heading: '90', pitch: '-45' },
    takeoff: { latitude: '37.7', longitude: '-122.4' },
  } satisfies MissionDraft;

  return {
    ...createEditorState(),
    draft,
    selectedPointId: selectedIndex === null ? null : points[selectedIndex]?.id ?? null,
  };
}

describe('editor shell inspector', () => {
  it('keeps route settings visible above an empty waypoint list and selection area', () => {
    render(
      <Inspector
        analysis={analyseDraft(createEditorState().draft)}
        dispatch={vi.fn<Dispatch<EditorAction>>()}
        state={createEditorState()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Route settings' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('');
    expect(screen.getByRole('region', { name: 'Waypoints' }).textContent).toContain('No waypoints yet.');
    expect(screen.getByRole('region', { name: 'Selected waypoint' }).textContent).toContain('Select a waypoint');
    const settings = screen.getByRole('region', { name: 'Route settings' });
    const waypoints = screen.getByRole('region', { name: 'Waypoints' });
    expect(settings.compareDocumentPosition(waypoints) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an untouched blank takeoff optional and quiet', () => {
    render(<MissionEditor />);

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff latitude' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff longitude' }).value).toBe('');
    expect(screen.getByRole('region', { name: 'Takeoff coordinates' }).textContent).toContain('Optional for route calculation');
    expect(screen.queryByRole('region', { name: 'Takeoff requirements' })).toBeNull();
  });

  it('edits takeoff as separate raw source without changing route points or calculated waypoints', async () => {
    const source = makeDraft();
    seedLocalDraft(source, true);
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    const latitude = screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff latitude' });
    const longitude = screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff longitude' });
    const takeoff = screen.getByRole('region', { name: 'Takeoff coordinates' });
    const routeTable = screen.getByRole('table', { name: 'Calculated waypoints' });
    const waypointRows = screen.getByRole('list', { name: 'Waypoint order' });
    const originalWaypoints = Array.from(routeTable.querySelectorAll('tbody tr'), (row) => row.textContent);
    const originalSource = Array.from(within(waypointRows).getAllByRole('listitem'), (row) => row.textContent);
    expect(latitude.value).toBe(source.takeoff?.latitude);
    expect(longitude.value).toBe(source.takeoff?.longitude);
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');

    fireEvent.change(latitude, { target: { value: source.takeoff?.latitude } });
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved');

    fireEvent.change(latitude, { target: { value: '-' } });
    expect(latitude.value).toBe('-');
    expect(longitude.value).toBe(source.takeoff?.longitude);
    expect(takeoff.textContent).toContain('Latitude: Enter a complete finite decimal number.');
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Not reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Unsaved');

    fireEvent.change(latitude, { target: { value: '91' } });
    expect(takeoff.textContent).toContain('Latitude: Enter a value between -90 and 90.');
    expect(Array.from(routeTable.querySelectorAll('tbody tr'), (row) => row.textContent)).toEqual(originalWaypoints);
    expect(Array.from(within(waypointRows).getAllByRole('listitem'), (row) => row.textContent)).toEqual(originalSource);

    fireEvent.change(latitude, { target: { value: source.takeoff?.latitude } });
    expect(latitude.value).toBe(source.takeoff?.latitude);
    expect(longitude.value).toBe(source.takeoff?.longitude);
    expect(screen.queryByRole('region', { name: 'Takeoff requirements' })).toBeNull();
    expect(Array.from(routeTable.querySelectorAll('tbody tr'), (row) => row.textContent)).toEqual(originalWaypoints);
    expect(Array.from(within(waypointRows).getAllByRole('listitem'), (row) => row.textContent)).toEqual(originalSource);

    fireEvent.change(latitude, { target: { value: '' } });
    expect(longitude.value).toBe(source.takeoff?.longitude);
    expect(takeoff.textContent).toContain('Latitude: Enter a complete finite decimal number.');
    fireEvent.change(longitude, { target: { value: '' } });
    expect(latitude.value).toBe('');
    expect(longitude.value).toBe('');
    expect(screen.queryByRole('region', { name: 'Takeoff requirements' })).toBeNull();
    expect(Array.from(routeTable.querySelectorAll('tbody tr'), (row) => row.textContent)).toEqual(originalWaypoints);
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toBe('Not reviewed');
  });

  it('keeps shared settings and target edits in source while applying planner limits', async () => {
    const source = makeDraft();
    seedLocalDraft(source, true);
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    const list = screen.getByRole('list', { name: 'Waypoint order' });
    const originalSource = Array.from(within(list).getAllByRole('listitem'), (row) => row.textContent);
    const framing = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Framing' });
    expect(screen.getByRole('button', { name: 'Set target' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(framing, { target: { value: 'face-target' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target latitude' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target longitude' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target height' }).value).toBe('');
    expect(screen.getByRole('button', { name: 'Set target' }).hasAttribute('disabled')).toBe(false);

    const sharedHeight = screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' });
    fireEvent.change(sharedHeight, { target: { value: ' 40 ' } });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target latitude' }), { target: { value: '37.776' } });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target longitude' }), { target: { value: '-122.419' } });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target height' }), { target: { value: '10' } });
    const table = screen.getByRole('table', { name: 'Calculated waypoints' });
    expect(sharedHeight.value).toBe(' 40 ');
    expect(Array.from(within(table).getAllByRole('cell', { name: '40' }))).toHaveLength(2);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff latitude' }).value).toBe(source.takeoff?.latitude);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Takeoff longitude' }).value).toBe(source.takeoff?.longitude);
    expect(Array.from(within(list).getAllByRole('listitem'), (row) => row.textContent)).toEqual(originalSource);

    fireEvent.change(sharedHeight, { target: { value: '1e' } });
    expect(sharedHeight.value).toBe('1e');
    expect(screen.queryByRole('table', { name: 'Calculated waypoints' })).toBeNull();
    fireEvent.change(sharedHeight, { target: { value: '40' } });
    expect(within(screen.getByRole('table', { name: 'Calculated waypoints' })).getAllByRole('cell', { name: '40' })).toHaveLength(2);

    fireEvent.change(framing, { target: { value: 'fixed' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Heading' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Gimbal pitch' }).value).toBe('');
    expect(screen.queryByRole('textbox', { name: 'Target latitude' })).toBeNull();
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Heading' }), { target: { value: '360' } });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Gimbal pitch' }), { target: { value: '90' } });
    expect(screen.queryByRole('table', { name: 'Calculated waypoints' })).toBeNull();
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Heading' }), { target: { value: '359.99' } });
    expect(Array.from(screen.getByRole('table', { name: 'Calculated waypoints' }).querySelectorAll('tbody tr'), (row) =>
      Array.from(row.querySelectorAll('td'), (cell) => cell.textContent))).toEqual([
      ['01', '37.7749', '-122.4194', '40', '359.99', '90'],
      ['02', '37.7759', '-122.4184', '40', '359.99', '90'],
    ]);
    expect(Array.from(within(list).getAllByRole('listitem'), (row) => row.textContent)).toEqual(originalSource);

    fireEvent.change(framing, { target: { value: 'face-target' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target latitude' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target longitude' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target height' }).value).toBe('');
  });

  it('shows selected coordinates without replacing route settings', () => {
    const state = stateWithPoints(1, 0);
    const dispatch = vi.fn<Dispatch<EditorAction>>();
    render(<Inspector analysis={analyseDraft(state.draft)} dispatch={dispatch} state={state} />);

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('32');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Framing' }).value).toBe('fixed');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Selected latitude' }).value).toBe('37');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Selected longitude' }).value).toBe('-122');
    fireEvent.change(screen.getByRole('textbox', { name: 'Selected latitude' }), { target: { value: '-' } });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'set-point-coordinate',
      id: state.draft.points[0]?.id,
      field: 'latitude',
      value: '-',
    });
  });

  it('marks the selected invalid coordinate and shows its canonical field error', async () => {
    const source = makeDraft();
    render(<MissionEditor />);
    fireEvent.change(screen.getByLabelText('Import backup'), {
      target: { files: [fileWithText('route.json', encodeBackup(source))] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select waypoint 1' }));

    const latitude = screen.getByRole('textbox', { name: 'Selected latitude' });
    const longitude = screen.getByRole('textbox', { name: 'Selected longitude' });
    fireEvent.change(latitude, { target: { value: '90.0001' } });

    expect(latitude.getAttribute('aria-invalid')).toBe('true');
    expect(longitude.getAttribute('aria-invalid')).not.toBe('true');
    expect(within(screen.getByRole('region', { name: 'Selected waypoint' })).getByRole('alert').textContent)
      .toContain('Too big: expected number to be <=90');
    expect(screen.queryByText('Enter a complete latitude and longitude to place this point.')).toBeNull();

    fireEvent.change(latitude, { target: { value: '37.775' } });

    expect(latitude.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('table', { name: 'Calculated waypoints' }).querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('keeps route settings and list controls available for a 100-point draft', () => {
    const state = stateWithPoints(100, 99);
    render(<Inspector analysis={analyseDraft(state.draft)} dispatch={vi.fn<Dispatch<EditorAction>>()} state={state} />);

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(100);
    expect(within(list).getByRole('button', { name: 'Select waypoint 100' })).toBeTruthy();
    expect(within(list).getAllByRole('button', { name: /^Select waypoint/ })).toHaveLength(100);
    expect(within(list).getAllByRole('button')).toHaveLength(300);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('32');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Selected latitude' }).value).toBe('37.099');
  });
});

describe('editor shell actions', () => {
  it('edits raw source and clears it with New', () => {
    render(<MissionEditor />);

    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Harbor survey' } });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }), { target: { value: '-' } });
    fireEvent.change(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Framing' }), { target: { value: 'fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add points' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Harbor survey');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('-');
    expect(screen.getByRole('button', { name: 'Add points' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Framing' }).value).toBe('');
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status', { name: 'Review status' }).textContent).toContain('Not reviewed');
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toContain('Unsaved');
  });

  it('inspects the saved slot without loading or writing until Load is selected', async () => {
    seedLocalDraft(makeDraft(), true);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    render(<MissionEditor />);

    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
    expect(write).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Current work' } });
    expect(write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Survey route');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('30');
    expectText(screen.getByRole('status', { name: 'Review status' }), 'Reviewed');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Saved');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not restore a reviewed mark from a draft that is not eligible for review', async () => {
    seedLocalDraft(makeDraft({ points: [] }), true);
    render(<MissionEditor />);

    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Survey route');
    expectText(screen.getByRole('status', { name: 'Review status' }), 'Not reviewed');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Saved');
  });

  it('reports an absent slot and preserves current unsaved work', async () => {
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'No saved draft');

    const routeName = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(routeName, { target: { value: 'Current work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expectText(screen.getByRole('alert'), 'No saved draft is available to load.');
    expect(routeName.value).toBe('Current work');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
  });

  it('reports a corrupt slot without changing the draft or its saved baseline', async () => {
    seedLocalDraft(makeDraft(), false);
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    const routeName = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(routeName, { target: { value: 'Current work' } });
    const [key] = Object.keys(window.localStorage);
    if (!key) throw new Error('Storage writer did not create a slot');
    window.localStorage.setItem(key, '{');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expectText(screen.getByRole('status', { name: 'Draft storage status' }), 'Saved draft is invalid');
    expectText(screen.getByRole('alert'), 'The saved draft is invalid and was not loaded');
    expect(routeName.value).toBe('Current work');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
    fireEvent.change(routeName, { target: { value: 'Survey route' } });
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Saved');
  });

  it('reports inaccessible storage without replacing the current draft or baseline', async () => {
    seedLocalDraft(makeDraft(), false);
    const localStorage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('storage blocked', 'SecurityError');
    });
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft is inaccessible');

    const routeName = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(routeName, { target: { value: 'Current work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expectText(screen.getByRole('alert'), 'storage blocked');
    expect(routeName.value).toBe('Current work');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
    expect(localStorage).toHaveBeenCalled();
  });

  it('keeps the saved slot after New and restores it only after explicit Load', async () => {
    const draft = makeDraft();
    seedLocalDraft(draft, false);
    render(<MissionEditor />);
    expectText(await screen.findByRole('status', { name: 'Draft storage status' }), 'Saved draft available');

    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Unsaved route' } });
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');
    expect(readLocalDraft(window.localStorage)).toEqual({ kind: 'success', draft, reviewed: false });

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe(draft.name);
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Saved');
  });

  it('imports validated source atomically, resets review and selection, and preserves the local slot', async () => {
    const saved = makeDraft({ name: 'Saved slot' });
    seedLocalDraft(saved, true);
    const slotBefore = readLocalDraft(window.localStorage);
    render(<MissionEditor />);
    const routeName = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(routeName, { target: { value: 'Current work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add points' }));
    const incoming = makeDraft({
      name: 'Imported route',
      height: '-',
      points: [{ id: '11111111-1111-4111-8111-111111111111', coordinate: { latitude: '1e', longitude: '' } }],
    });

    fireEvent.change(screen.getByLabelText('Import backup'), {
      target: { files: [fileWithText('route.json', encodeBackup(incoming))] },
    });

    expect(await screen.findByDisplayValue('Imported route')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Height above takeoff' }).value).toBe('-');
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
    expectText(screen.getByRole('status', { name: 'Review status' }), 'Not reviewed');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
    expect(readLocalDraft(window.localStorage)).toEqual(slotBefore);
  });

  it('keeps current source and its saved baseline when an imported backup is invalid', async () => {
    const baseline = makeDraft({ name: 'Saved baseline' });
    seedLocalDraft(baseline, false);
    render(<MissionEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const source = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(source, { target: { value: 'Current work' } });
    const invalid = JSON.stringify({ version: 1, draft: { ...makeDraft(), extra: true } });

    fireEvent.change(screen.getByLabelText('Import backup'), {
      target: { files: [fileWithText('invalid.json', invalid)] },
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid and was not imported/i);
    expect(source.value).toBe('Current work');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
    fireEvent.change(source, { target: { value: baseline.name } });
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Saved');
  });

  it('keeps current source when the selected backup cannot be read', async () => {
    render(<MissionEditor />);
    const source = screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' });
    fireEvent.change(source, { target: { value: 'Current work' } });

    fireEvent.change(screen.getByLabelText('Import backup'), {
      target: { files: [fileWithText('unreadable.json', () => Promise.reject(new Error('read failed')))] },
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read/i);
    expect(source.value).toBe('Current work');
    expectText(screen.getByRole('status', { name: 'Save status' }), 'Unsaved');
  });

  it('applies only the most recently selected backup when file reads overlap', async () => {
    render(<MissionEditor />);
    let finishFirst: (text: string) => void = () => undefined;
    const latest = makeDraft({ name: 'Latest import' });
    const input = screen.getByLabelText('Import backup');
    fireEvent.change(input, {
      target: { files: [fileWithText('first.json', () => new Promise<string>((resolve) => { finishFirst = resolve; }))] },
    });
    fireEvent.change(input, { target: { files: [fileWithText('latest.json', encodeBackup(latest))] } });

    expect(await screen.findByDisplayValue('Latest import')).toBeTruthy();
    finishFirst(encodeBackup(makeDraft({ name: 'Stale import' })));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Latest import');
  });

  it('does not apply a delayed import after the source changes', async () => {
    render(<MissionEditor />);
    let finishImport: (text: string) => void = () => undefined;
    const input = screen.getByLabelText('Import backup');
    fireEvent.change(input, {
      target: { files: [fileWithText('delayed.json', () => new Promise<string>((resolve) => { finishImport = resolve; }))] },
    });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Newer work' } });
    await act(async () => { finishImport(encodeBackup(makeDraft({ name: 'Stale import' }))); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Newer work');
  });

  it('does not apply a delayed import after New or Load', async () => {
    const saved = makeDraft({ name: 'Loaded work' });
    seedLocalDraft(saved, false);
    render(<MissionEditor />);
    const input = screen.getByLabelText('Import backup');
    let finishNewImport: (text: string) => void = () => undefined;
    fireEvent.change(input, {
      target: { files: [fileWithText('delayed-new.json', () => new Promise<string>((resolve) => { finishNewImport = resolve; }))] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await act(async () => { finishNewImport(encodeBackup(makeDraft({ name: 'Stale after New' }))); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('');

    let finishLoadImport: (text: string) => void = () => undefined;
    fireEvent.change(input, {
      target: { files: [fileWithText('delayed-load.json', () => new Promise<string>((resolve) => { finishLoadImport = resolve; }))] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await act(async () => { finishLoadImport(encodeBackup(makeDraft({ name: 'Stale after Load' }))); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe(saved.name);
  });

  it('does not show a delayed import error after the source changes', async () => {
    render(<MissionEditor />);
    let finishImport: (text: string) => void = () => undefined;
    const input = screen.getByLabelText('Import backup');
    fireEvent.change(input, {
      target: { files: [fileWithText('invalid.json', () => new Promise<string>((resolve) => { finishImport = resolve; }))] },
    });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Newer work' } });
    await act(async () => { finishImport('{'); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Newer work');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not show a delayed read failure after the source changes', async () => {
    render(<MissionEditor />);
    let rejectImport: (error: Error) => void = () => undefined;
    const input = screen.getByLabelText('Import backup');
    fireEvent.change(input, {
      target: { files: [fileWithText('unreadable.json', () => new Promise<string>((_, reject) => { rejectImport = reject; }))] },
    });
    fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }), { target: { value: 'Newer work' } });
    await act(async () => { rejectImport(new Error('read failed')); });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Newer work');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('allows a delayed import after selection-only changes', async () => {
    render(<MissionEditor />);
    const initial = makeDraft({ name: 'Initial', points: [{
      id: '11111111-1111-4111-8111-111111111111',
      coordinate: { latitude: '37', longitude: '-122' },
    }] });
    const input = screen.getByLabelText('Import backup');
    fireEvent.change(input, { target: { files: [fileWithText('initial.json', encodeBackup(initial))] } });
    await screen.findByDisplayValue('Initial');

    let finishImport: (text: string) => void = () => undefined;
    fireEvent.change(input, {
      target: { files: [fileWithText('delayed.json', () => new Promise<string>((resolve) => { finishImport = resolve; }))] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select waypoint 1' }));
    await act(async () => { finishImport(encodeBackup(makeDraft({ name: 'Imported after selection' }))); });

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Route name' }).value).toBe('Imported after selection');
  });
});
