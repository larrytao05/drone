'use client';

import type { ComponentProps, Dispatch, KeyboardEvent } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { RoutePoint } from './editor';
import type { OrdinaryEditorAction } from './editor-session';
import styles from './Editor.module.css';

type WaypointListProps = Readonly<{
  points: readonly RoutePoint[];
  selectedPointId: string | null;
  dispatch: Dispatch<OrdinaryEditorAction>;
}>;

type WaypointRowProps = Readonly<{
  point: RoutePoint;
  index: number;
  selected: boolean;
  dispatch: Dispatch<OrdinaryEditorAction>;
}>;

function WaypointRow({ point, index, selected, dispatch }: WaypointRowProps) {
  const { ref, handleRef } = useSortable({ id: point.id, index });
  const ordinal = index + 1;

  function selectOnRowEnter(event: KeyboardEvent<HTMLLIElement>) {
    if (event.key === 'Enter' && event.target === event.currentTarget) {
      dispatch({ type: 'select-point', id: point.id });
    }
  }

  return (
    <li
      aria-current={selected ? 'true' : undefined}
      className={styles.waypointItem}
      onKeyDown={selectOnRowEnter}
      ref={ref}
      tabIndex={0}
    >
      <button
        aria-label={`Select waypoint ${ordinal}`}
        className={styles.waypointRow}
        onClick={() => dispatch({ type: 'select-point', id: point.id })}
        type="button"
      >
        <span className={styles.waypointNumber}>{String(ordinal).padStart(2, '0')}</span>
        <span className={styles.waypointCoordinates}>
          <span>{point.coordinate.latitude || 'Latitude unset'}</span>
          <span>{point.coordinate.longitude || 'Longitude unset'}</span>
        </span>
      </button>
      <button
        aria-label={`Reorder waypoint ${ordinal}`}
        className={styles.waypointReorder}
        ref={handleRef}
        type="button"
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <button
        aria-label={`Delete waypoint ${ordinal}`}
        className={styles.waypointDelete}
        onClick={() => dispatch({ type: 'delete-point', id: point.id })}
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

export function WaypointList({ points, selectedPointId, dispatch }: WaypointListProps) {
  function finishReorder(event: Parameters<NonNullable<ComponentProps<typeof DragDropProvider>['onDragEnd']>>[0]) {
    if (event.canceled) return;

    const { source, target } = event.operation;
    if (!isSortable(source) || !isSortable(target)) return;
    if (!points.some((point) => point.id === target.id)) return;
    if (points[source.initialIndex]?.id !== source.id) return;
    if (!Number.isInteger(source.index) || source.index < 0 || source.index >= points.length) return;
    if (source.initialIndex === source.index) return;

    const reordered = [...points];
    const [moved] = reordered.splice(source.initialIndex, 1);
    if (!moved) return;
    reordered.splice(source.index, 0, moved);
    if (reordered.every((point, position) => point.id === points[position]?.id)) return;

    dispatch({
      type: 'reorder-point',
      id: moved.id,
      beforeId: reordered[source.index + 1]?.id ?? null,
    });
  }

  return (
    <DragDropProvider onDragEnd={finishReorder}>
      {points.length === 0 ? (
        <p className={styles.emptyList}>No waypoints yet. Add them from the map when map editing is available.</p>
      ) : (
        <ol aria-label="Waypoint order" className={styles.waypointList}>
          {points.map((point, index) => (
            <WaypointRow
              dispatch={dispatch}
              index={index}
              key={point.id}
              point={point}
              selected={point.id === selectedPointId}
            />
          ))}
        </ol>
      )}
    </DragDropProvider>
  );
}
