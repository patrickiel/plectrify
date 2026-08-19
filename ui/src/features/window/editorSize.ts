/**
 * The resize handles' arithmetic, pure so it can be tested: the size a plugin
 * editor should become, given which edge was pressed, where it was pressed and
 * where the pointer is now. CSS pixels throughout — the page fills the editor,
 * so they are the editor's own points, and the handles mount outside every
 * --ui-scale zoom wrapper so no scale division applies.
 */

/** Which of the editor's own dimensions a handle drags. Only the right and
    bottom edges exist: a plugin can ask its host for a new *size* and nothing
    else, so dragging the left or top edge would have to move the window's
    origin — which no host offers a plugin — and would instead grow the window
    away from the pointer. */
export type EditorResizeEdge = 'right' | 'bottom' | 'bottom-right';

export interface GripStart {
  /** Which edge is being dragged. */
  edge: EditorResizeEdge;
  /** Pointer position at the press, in CSS pixels. */
  pointerX: number;
  pointerY: number;
  /** Editor size at the press (window.innerWidth/innerHeight). */
  width: number;
  height: number;
}

/** The editor's own setResizeLimits floor — kept in step with
    PluginEditor.cpp, and enforced again native-side where the size is
    applied. */
export const MIN_EDITOR_SIZE = { width: 760, height: 480 } as const;

/** The size the editor should become with the pointer at (x, y): the pressed
    size plus the drag delta along whichever axes the edge owns, never below
    the floor. An axis the edge does not own keeps its pressed value, so a drag
    down the right edge cannot nudge the height by a few stray pixels. */
export function grippedSize(
  start: GripStart,
  pointer: { x: number; y: number },
): { width: number; height: number } {
  const horizontal = start.edge !== 'bottom';
  const vertical = start.edge !== 'right';

  return {
    width: horizontal
      ? Math.max(MIN_EDITOR_SIZE.width, Math.round(start.width + pointer.x - start.pointerX))
      : Math.max(MIN_EDITOR_SIZE.width, Math.round(start.width)),
    height: vertical
      ? Math.max(MIN_EDITOR_SIZE.height, Math.round(start.height + pointer.y - start.pointerY))
      : Math.max(MIN_EDITOR_SIZE.height, Math.round(start.height)),
  };
}
