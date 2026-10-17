import { planMission } from '@drone/mission-planner';
import type { Coordinate, Framing, InputIssue, PlanResult } from '@drone/mission-planner';
import type { CoordinateText, MissionDraft, RoutePoint } from './editor';
import { parseNumericText } from './numeric-input';

export type EditorIssue = InputIssue & Readonly<{
  pointId?: string;
  field?: keyof CoordinateText | 'height' | 'heading' | 'pitch' | 'framing';
}>;
export type DraftAnalysis = Readonly<{
  route:
    | Extract<PlanResult, { kind: 'calculated' }>
    | Readonly<{ kind: 'not-calculated'; issues: readonly EditorIssue[] }>;
  sourcePoints: readonly Readonly<{ id: string; coordinate: Coordinate }>[];
  takeoff: Coordinate | null;
  target: Coordinate | null;
  takeoffIssues: readonly EditorIssue[];
  reviewEligible: boolean;
}>;

type ParsedCoordinate = Readonly<{
  numeric: Coordinate | null;
  source: Coordinate | null;
  issues: readonly EditorIssue[];
}>;

function editorIssue(issue: InputIssue, points: readonly RoutePoint[]): EditorIssue {
  const [section, collection, index] = issue.path;
  const point = section === 'shot' && collection === 'anchors' && typeof index === 'number'
    ? points[index] : undefined;
  const last = issue.path.at(-1);
  const field = last === 'latitudeDeg' ? 'latitude'
    : last === 'longitudeDeg' ? 'longitude'
    : last === 'heightAboveTakeoffM' ? 'height'
    : last === 'headingDeg' ? 'heading'
    : last === 'gimbalPitchDeg' ? 'pitch'
    : last === 'framing' ? 'framing' : undefined;
  return { ...issue, ...(point === undefined ? {} : { pointId: point.id }), ...(field === undefined ? {} : { field }) };
}

function numericIssue(path: InputIssue['path']): InputIssue {
  return { path, code: 'malformed', message: 'Enter a complete finite decimal number.' };
}

function parseCoordinate(text: CoordinateText, path: InputIssue['path'], points: readonly RoutePoint[]): ParsedCoordinate {
  const latitudeDeg = parseNumericText(text.latitude);
  const longitudeDeg = parseNumericText(text.longitude);
  const issues: EditorIssue[] = [];
  for (const [field, value, limit] of [
    ['latitudeDeg', latitudeDeg, 90], ['longitudeDeg', longitudeDeg, 180],
  ] satisfies readonly (readonly [string, number | null, number])[]) {
    if (value === null) {
      issues.push(editorIssue(numericIssue([...path, field]), points));
    } else if (value < -limit || value > limit) {
      issues.push(editorIssue({ path: [...path, field], code: 'malformed', message: `Enter a value between ${-limit} and ${limit}.` }, points));
    }
  }
  const numeric = latitudeDeg === null || longitudeDeg === null ? null : { latitudeDeg, longitudeDeg };
  return { numeric, source: issues.length === 0 ? numeric : null, issues };
}

function parseFraming(draft: MissionDraft, issues: EditorIssue[], target: ParsedCoordinate | null): Framing | null {
  const framing = draft.framing;
  if (framing.kind === 'unselected') {
    issues.push({ path: ['framing'], code: 'missing', message: 'Choose a framing mode.', field: 'framing' });
    return null;
  }
  if (framing.kind === 'fixed') {
    const headingDeg = parseNumericText(framing.heading);
    const gimbalPitchDeg = parseNumericText(framing.pitch);
    if (headingDeg === null) issues.push(editorIssue(numericIssue(['framing', 'headingDeg']), draft.points));
    if (gimbalPitchDeg === null) issues.push(editorIssue(numericIssue(['framing', 'gimbalPitchDeg']), draft.points));
    return headingDeg === null || gimbalPitchDeg === null ? null : { kind: 'fixed', headingDeg, gimbalPitchDeg };
  }
  const heightAboveTakeoffM = parseNumericText(framing.height);
  if (heightAboveTakeoffM === null) issues.push(editorIssue(numericIssue(['framing', 'target', 'heightAboveTakeoffM']), draft.points));
  return target === null || target.numeric === null || heightAboveTakeoffM === null
    ? null : { kind: 'face-target', target: { coordinate: target.numeric, heightAboveTakeoffM } };
}

export function analyseDraft(draft: MissionDraft): DraftAnalysis {
  const points = draft.points;
  const anchors: Coordinate[] = [];
  const sourcePoints: { id: string; coordinate: Coordinate }[] = [];
  const coordinateIssues: EditorIssue[] = [];
  points.forEach((point, index) => {
    const parsed = parseCoordinate(point.coordinate, ['shot', 'anchors', index], points);
    if (parsed.numeric !== null) anchors.push(parsed.numeric);
    if (parsed.source !== null) sourcePoints.push({ id: point.id, coordinate: parsed.source });
    coordinateIssues.push(...parsed.issues);
  });
  const target = draft.framing.kind === 'face-target'
    ? parseCoordinate(draft.framing.coordinate, ['framing', 'target', 'coordinate'], points) : null;
  if (target !== null) coordinateIssues.push(...target.issues);
  const issues = [...coordinateIssues];
  const heightAboveTakeoffM = parseNumericText(draft.height);
  if (heightAboveTakeoffM === null) issues.push(editorIssue(numericIssue(['heightAboveTakeoffM']), points));
  const framing = parseFraming(draft, issues, target);
  const result = anchors.length === points.length && heightAboveTakeoffM !== null && framing !== null
    ? planMission({ shot: { kind: 'route', anchors }, heightAboveTakeoffM, framing }) : null;
  const route: DraftAnalysis['route'] = result?.kind === 'calculated' ? result
    : { kind: 'not-calculated', issues: result === null ? issues : result.issues.map((issue) => editorIssue(issue, points)) };
  const takeoff = draft.takeoff === null ? null : parseCoordinate(draft.takeoff, ['takeoff'], points);
  const takeoffIssues = takeoff === null
    ? [{ path: ['takeoff'], code: 'missing', message: 'Set a takeoff coordinate before reviewing.' }]
    : takeoff.issues;
  const takeoffCoordinate = takeoff?.source ?? null;
  return { route, sourcePoints, takeoff: takeoffCoordinate, target: target?.source ?? null, takeoffIssues,
    reviewEligible: route.kind === 'calculated' && takeoffCoordinate !== null };
}
