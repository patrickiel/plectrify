/**
 * The resize grip's arithmetic, pure so it can be tested: the size a plugin
 * editor should become, given where the grip was pressed and where the
 * pointer is now. CSS pixels throughout — the page fills the editor, so they
 * are the editor's own points, and the grip mounts outside every --ui-scale
 * zoom wrapper so no scale division applies.
 */

export interface GripStart {
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
    size plus the drag delta, never below the floor. */
export function grippedSize(
  start: GripStart,
  pointer: { x: number; y: number },
): { width: number; height: number } {
  return {
    width: Math.max(MIN_EDITOR_SIZE.width, Math.round(start.width + pointer.x - start.pointerX)),
    height: Math.max(MIN_EDITOR_SIZE.height, Math.round(start.height + pointer.y - start.pointerY)),
  };
}
