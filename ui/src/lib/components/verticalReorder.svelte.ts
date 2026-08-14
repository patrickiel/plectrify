/**
 * Pointer-driven vertical reordering for menu lists (the rig and scene menus).
 *
 * Deliberately not HTML5 drag-and-drop: that paints a translucent ghost of the
 * row under the cursor and lets it wander anywhere on screen. Here the row
 * never leaves its own track — movement is vertical only, clamped to the list,
 * and the rest of the rows slide out of the way so the pending order is always
 * what you see. Nothing is committed until the pointer is released.
 *
 * Markup contract: spread `{...reorder.listAttrs}` and add `reorder.listClass`
 * on the list; spread `{...reorder.itemAttrs(i)}` and add
 * `reorder.itemClass(i)` on each row. The handle wires the pointer events.
 * Scoped module classes carry the preview styling without a global CSS
 * contract.
 */

import styles from './verticalReorder.module.css';

/** A row's measured geometry, in the list's own coordinate space. */
export interface Row {
  top: number;
  height: number;
  center: number;
}

/** Keep the dragged row inside the list: it can never travel past either end.
    `dy` is the raw pointer movement. */
export function clampOffset(rows: Row[], from: number, dy: number): number {
  const row = rows[from];
  const first = rows[0];
  const last = rows[rows.length - 1];
  const min = first.top - row.top;
  const max = last.top + last.height - (row.top + row.height);
  return Math.max(min, Math.min(max, dy));
}

/** Where the dragged row would land, given a clamped offset.
 *
 * The test is the dragged row's *leading edge* against the other rows' centres
 * — the furthest one crossed in the direction of travel wins. The leading edge,
 * not the centre: at full travel the centres only ever meet, never cross, which
 * would leave the first and last slots permanently out of reach.
 */
export function landingIndex(rows: Row[], from: number, offset: number): number {
  if (offset < 0) {
    const top = rows[from].top + offset;
    for (let i = 0; i < from; i++) if (top < rows[i].center) return i;
  } else {
    const bottom = rows[from].top + rows[from].height + offset;
    for (let i = rows.length - 1; i > from; i--) if (bottom > rows[i].center) return i;
  }
  return from;
}

export class VerticalReorder {
  /** Index of the row being dragged, or -1 when idle. */
  from = $state(-1);
  /** Index the dragged row would land at if released now. */
  to = $state(-1);
  /** Live vertical offset of the dragged row, in px, clamped to the list. */
  offset = $state(0);

  #rows: Row[] = [];
  #startY = 0;
  #pointerId = -1;
  #commit: (from: number, to: number) => void;

  constructor(commit: (from: number, to: number) => void) {
    this.#commit = commit;
  }

  /** Whether a drag is in progress — drives the rows' transition styling. */
  get active(): boolean {
    return this.from >= 0;
  }

  /** Spread onto the list element so handles can find their owning list. */
  get listAttrs(): Record<string, string | undefined> {
    return {
      'data-reorder-list': '',
    };
  }

  /** Scoped preview class for the list while a drag is active. */
  get listClass(): string | undefined {
    return this.active ? styles.reordering : undefined;
  }

  /** Spread onto row `index`; carries its pending inline displacement. */
  itemAttrs(index: number): Record<string, string | undefined> {
    return {
      'data-reorder-item': '',
      style: this.active ? `transform: translateY(${this.shift(index)}px)` : undefined,
    };
  }

  /** Scoped base and dragging-state classes for row `index`. */
  itemClass(index: number): string {
    return this.from === index ? `${styles.item} ${styles.dragging}` : styles.item;
  }

  /** How far the row at `index` is displaced by the pending move, in px.
      The dragged row follows the pointer; the rows it has passed step aside
      by exactly its height. */
  shift(index: number): number {
    if (this.from < 0) return 0;
    if (index === this.from) return this.offset;
    const height = this.#rows[this.from]?.height ?? 0;
    if (this.to > this.from && index > this.from && index <= this.to) return -height;
    if (this.to < this.from && index >= this.to && index < this.from) return height;
    return 0;
  }

  start(event: PointerEvent, index: number): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const list = handle.closest('[data-reorder-list]');
    const items = list ? [...list.querySelectorAll<HTMLElement>('[data-reorder-item]')] : [];
    if (items.length < 2) return;

    // Own the gesture: without this the popover's outside-click watcher and the
    // rack's pan handler both get a look at it first.
    event.preventDefault();
    event.stopPropagation();

    // Offsets, not viewport rects, so the measurements stay valid if the list
    // is scrolled — everything moves together inside the same coordinate space.
    this.#rows = items.map((el) => ({
      top: el.offsetTop,
      height: el.offsetHeight,
      center: el.offsetTop + el.offsetHeight / 2,
    }));
    this.#startY = event.clientY;
    this.#pointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    // The handle does not take focus (preventDefault above), so Escape has to
    // be caught at the window for the duration of the drag.
    window.addEventListener('keydown', this.#onKeydown, true);
    this.from = index;
    this.to = index;
    this.offset = 0;
  }

  move(event: PointerEvent): void {
    if (this.from < 0 || event.pointerId !== this.#pointerId) return;
    this.offset = clampOffset(this.#rows, this.from, event.clientY - this.#startY);
    this.to = landingIndex(this.#rows, this.from, this.offset);
  }

  end(event: PointerEvent): void {
    if (this.from < 0 || event.pointerId !== this.#pointerId) return;
    const from = this.from;
    const to = this.to;
    this.#reset();
    if (to !== from) this.#commit(from, to);
  }

  /** Abandon the drag and snap everything back (Escape, or a lost capture). */
  cancel(): void {
    this.#reset();
  }

  /** Keyboard equivalent of the drag, for the handle itself. */
  keydown(event: KeyboardEvent, index: number, count: number): void {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    const to = index + delta;
    if (to < 0 || to >= count) return;
    event.preventDefault();
    event.stopPropagation();
    this.#commit(index, to);
  }

  // Bound once so the listener can be removed again.
  #onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.from < 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  #reset(): void {
    window.removeEventListener('keydown', this.#onKeydown, true);
    this.from = -1;
    this.to = -1;
    this.offset = 0;
    this.#pointerId = -1;
    this.#rows = [];
  }
}
