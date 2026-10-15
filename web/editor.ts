import { analyseDraft } from './mission-input';
export { analyseDraft } from './mission-input';
export type { DraftAnalysis, EditorIssue } from './mission-input';

export type CoordinateText = Readonly<{ latitude: string; longitude: string }>;
export type RoutePoint = Readonly<{ id: string; coordinate: CoordinateText }>;
export type Framing =
  | Readonly<{ kind: 'unselected' }>
  | Readonly<{ kind: 'fixed'; heading: string; pitch: string }>
  | Readonly<{ kind: 'face-target'; coordinate: CoordinateText; height: string }>;
export type MissionDraft = Readonly<{
  name: string;
  points: readonly RoutePoint[];
  height: string;
  framing: Framing;
  takeoff: CoordinateText | null;
}>;
export type Review =
  | Readonly<{ kind: 'unreviewed' }>
  | Readonly<{ kind: 'reviewed'; revision: number }>;
export type EditorState = Readonly<{
  draft: MissionDraft;
  revision: number;
  review: Review;
  selectedPointId: string | null;
  tool: 'select' | 'add-points' | 'set-takeoff' | 'set-target';
  savedSnapshotKey: string | null;
}>;
export type EditorAction =
  | Readonly<{ type: 'new' }>
  | Readonly<{ type: 'set-name' | 'set-height'; value: string }>
  | Readonly<{ type: 'append-point'; point: RoutePoint }>
  | Readonly<{ type: 'select-point'; id: string | null }>
  | Readonly<{ type: 'set-tool'; tool: EditorState['tool'] }>
  | Readonly<{ type: 'set-point-coordinate'; id: string; field: keyof CoordinateText; value: string }>
  | Readonly<{ type: 'move-point'; id: string; coordinate: CoordinateText }>
  | Readonly<{ type: 'delete-point'; id: string }>
  | Readonly<{ type: 'reorder-point'; id: string; beforeId: string | null }>
  | Readonly<{ type: 'set-framing'; kind: Framing['kind'] }>
  | Readonly<{ type: 'set-fixed-framing'; field: 'heading' | 'pitch'; value: string }>
  | Readonly<{ type: 'set-target-coordinate'; field: keyof CoordinateText; value: string }>
  | Readonly<{ type: 'set-target-height'; value: string }>
  | Readonly<{ type: 'set-target'; coordinate: CoordinateText }>
  | Readonly<{ type: 'set-takeoff'; coordinate: CoordinateText | null }>
  | Readonly<{ type: 'import-draft'; draft: MissionDraft }>
  | Readonly<{ type: 'load-draft'; draft: MissionDraft; reviewed: boolean }>
  | Readonly<{ type: 'save-succeeded'; revision: number; reviewed: boolean }>;

function blankDraft(): MissionDraft {
  return { name: '', points: [], height: '', framing: { kind: 'unselected' }, takeoff: null };
}

export function createEditorState(): EditorState {
  return {
    draft: blankDraft(), revision: 0, review: { kind: 'unreviewed' },
    selectedPointId: null, tool: 'select', savedSnapshotKey: null,
  };
}

function sameCoordinate(left: CoordinateText | null, right: CoordinateText | null): boolean {
  if (left === null || right === null) return left === right;
  return left.latitude === right.latitude && left.longitude === right.longitude;
}

function changeSource(state: EditorState, draft: MissionDraft): EditorState {
  return { ...state, draft, revision: state.revision + 1, review: { kind: 'unreviewed' } };
}

function framingSnapshot(framing: Framing): readonly string[] {
  switch (framing.kind) {
    case 'unselected': return [framing.kind];
    case 'fixed': return [framing.kind, framing.heading, framing.pitch];
    case 'face-target': return [framing.kind, framing.coordinate.latitude, framing.coordinate.longitude, framing.height];
  }
}

function snapshotKey(draft: MissionDraft, review: Review): string {
  return JSON.stringify([
    draft.name,
    draft.points.map((point) => [point.id, point.coordinate.latitude, point.coordinate.longitude]),
    draft.height,
    framingSnapshot(draft.framing),
    draft.takeoff === null ? null : [draft.takeoff.latitude, draft.takeoff.longitude],
    review.kind === 'reviewed',
  ]);
}

export function isSaved(state: EditorState): boolean {
  return state.savedSnapshotKey === snapshotKey(state.draft, state.review);
}

function movePoint(state: EditorState, id: string, coordinate: CoordinateText): EditorState {
  const point = state.draft.points.find((item) => item.id === id);
  if (!point || sameCoordinate(point.coordinate, coordinate)) return state;
  const points = state.draft.points.map((item) => item.id === id ? { ...item, coordinate } : item);
  return changeSource(state, { ...state.draft, points });
}

function reorderPoint(state: EditorState, id: string, beforeId: string | null): EditorState {
  const points = state.draft.points;
  const point = points.find((item) => item.id === id);
  if (!point || id === beforeId) return state;
  if (beforeId !== null && !points.some((item) => item.id === beforeId)) return state;
  const remaining = points.filter((item) => item.id !== id);
  const index = beforeId === null ? remaining.length : remaining.findIndex((item) => item.id === beforeId);
  const reordered = [...remaining.slice(0, index), point, ...remaining.slice(index)];
  if (reordered.every((item, position) => item === points[position])) return state;
  return changeSource(state, { ...state.draft, points: reordered });
}

function emptyFraming(kind: Framing['kind']): Framing {
  switch (kind) {
    case 'unselected': return { kind };
    case 'fixed': return { kind, heading: '', pitch: '' };
    case 'face-target': return { kind, coordinate: { latitude: '', longitude: '' }, height: '' };
  }
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const draft = state.draft;
  switch (action.type) {
    case 'new': {
      const blank = blankDraft();
      const isBlank = draft.name === '' && draft.points.length === 0 && draft.height === ''
        && draft.framing.kind === 'unselected' && draft.takeoff === null;
      if (isBlank && state.selectedPointId === null && state.tool === 'select'
        && state.review.kind === 'unreviewed') return state;
      const next = isBlank ? state : changeSource(state, blank);
      return { ...next, selectedPointId: null, tool: 'select', review: { kind: 'unreviewed' } };
    }
    case 'set-name':
      if (draft.name === action.value) return state;
      return changeSource(state, { ...draft, name: action.value });
    case 'set-height':
      if (draft.height === action.value) return state;
      return changeSource(state, { ...draft, height: action.value });
    case 'append-point':
      if (draft.points.some((point) => point.id === action.point.id)) return state;
      return { ...changeSource(state, { ...draft, points: [...draft.points, action.point] }), selectedPointId: action.point.id };
    case 'select-point':
      if (action.id === state.selectedPointId) return state;
      if (action.id !== null && !draft.points.some((point) => point.id === action.id)) return state;
      return { ...state, selectedPointId: action.id };
    case 'set-tool':
      if (action.tool === state.tool) return state;
      if (action.tool === 'set-target' && draft.framing.kind !== 'face-target') return state;
      return { ...state, tool: action.tool };
    case 'set-point-coordinate': {
      const point = draft.points.find((item) => item.id === action.id);
      if (!point) return state;
      return movePoint(state, action.id, { ...point.coordinate, [action.field]: action.value });
    }
    case 'move-point': return movePoint(state, action.id, action.coordinate);
    case 'delete-point': {
      if (!draft.points.some((point) => point.id === action.id)) return state;
      const points = draft.points.filter((point) => point.id !== action.id);
      return {
        ...changeSource(state, { ...draft, points }),
        selectedPointId: state.selectedPointId === action.id ? null : state.selectedPointId,
      };
    }
    case 'reorder-point': return reorderPoint(state, action.id, action.beforeId);
    case 'set-framing': {
      if (draft.framing.kind === action.kind) return state;
      const next = changeSource(state, { ...draft, framing: emptyFraming(action.kind) });
      return { ...next, tool: state.tool === 'set-target' ? 'select' : state.tool };
    }
    case 'set-fixed-framing': {
      const framing = draft.framing;
      if (framing.kind !== 'fixed' || framing[action.field] === action.value) return state;
      return changeSource(state, { ...draft, framing: { ...framing, [action.field]: action.value } });
    }
    case 'set-target-coordinate': {
      const framing = draft.framing;
      if (framing.kind !== 'face-target' || framing.coordinate[action.field] === action.value) return state;
      return changeSource(state, { ...draft, framing: { ...framing, coordinate: { ...framing.coordinate, [action.field]: action.value } } });
    }
    case 'set-target-height': {
      const framing = draft.framing;
      if (framing.kind !== 'face-target' || framing.height === action.value) return state;
      return changeSource(state, { ...draft, framing: { ...framing, height: action.value } });
    }
    case 'set-target': {
      const framing = draft.framing;
      if (framing.kind !== 'face-target' || sameCoordinate(framing.coordinate, action.coordinate)) return state;
      return changeSource(state, { ...draft, framing: { ...framing, coordinate: action.coordinate } });
    }
    case 'set-takeoff':
      if (sameCoordinate(draft.takeoff, action.coordinate)) return state;
      return changeSource(state, { ...draft, takeoff: action.coordinate });
    case 'import-draft':
      return { ...changeSource(state, action.draft), selectedPointId: null, tool: 'select' };
    case 'load-draft': {
      const revision = state.revision + 1;
      const review: Review = action.reviewed && analyseDraft(action.draft).reviewEligible
        ? { kind: 'reviewed', revision } : { kind: 'unreviewed' };
      const next = { ...state, draft: action.draft, revision, review, selectedPointId: null, tool: 'select' } satisfies EditorState;
      return { ...next, savedSnapshotKey: snapshotKey(next.draft, next.review) };
    }
    case 'save-succeeded': {
      if (action.revision !== state.revision) return state;
      if (action.reviewed && !analyseDraft(draft).reviewEligible) return state;
      const review: Review = action.reviewed ? { kind: 'reviewed', revision: state.revision } : { kind: 'unreviewed' };
      return { ...state, review, savedSnapshotKey: snapshotKey(draft, review) };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
