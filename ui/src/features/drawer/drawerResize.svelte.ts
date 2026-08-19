import type { HTMLAttributes } from 'svelte/elements';
import { MAX_DRAWER_HEIGHT, MIN_DRAWER_HEIGHT } from '../../lib/engine/appSettings';

/**
 * The module drawer's height: the grab bar is one control with two gestures.
 *
 * A drag resizes (live height here, committed to the persisted setting on
 * release, so settings.json is written once per gesture rather than at pointer
 * rate), and a plain click — a release that never really moved — toggles the
 * collapse. Dragging up from collapsed expands; dragging well past the minimum
 * height collapses, so the whole range is reachable in one motion.
 *
 * Markup contract: spread `{...resize.shelfAttrs}` on the shelf band itself —
 * `setPointerCapture` is taken on `currentTarget` and the SHELF_CONTROLS
 * opt-out tests `target.closest(…)`, so both are only correct on the element
 * that *is* the band. `resize.keydown` goes on the grip separately: it is the
 * focusable separator, and it carries a tooltip attachment that would not
 * spread. Whatever measures the band writes its height back to
 * `resize.shelfHeight`.
 *
 * The gesture reads its surroundings through the getter bag handed to the
 * constructor — never plain values, which JS would freeze at construction.
 * Store the bag; do not destructure it.
 *
 * The pure halves are exported beside the class so they can be tested without
 * a DOM (the suite runs in node).
 */

/** The shelf — grab bar plus header row — is what a collapsed drawer keeps.
    A bare 16px grip was a hairline nobody could find, and the header holds
    the two controls (Browse TONE3000, the filter) that are worth reaching
    without reopening the list. Measured rather than assumed: the header's
    own height moves with the chrome type scale and with the container
    queries that drop its label text. The fallback is only what is drawn for
    the first frame before the box is measured. */
export const SHELF_FALLBACK = 54;

/** Released in the bottom tenth of the workspace → collapse; in the top
    fifth → snap to full height. No buttons for either: the extremes of the
    one drag gesture are the maximize and minimize. */
const COLLAPSE_FRACTION = 0.1;
const MAXIMIZE_FRACTION = 0.8;

/** Under this much movement a gesture is a click, not a drag. */
const CLICK_SLOP = 4;

/** How far one arrow key moves the edge. */
const HEIGHT_STEP = 24;

/** Anything on the shelf that owns the pointer itself — the TONE3000 tile
    (which is dragged), the filter field, the buttons. The shelf is the
    resize surface everywhere else. */
const SHELF_CONTROLS = 'button, input, textarea, select, a, label, [draggable="true"]';

/** A stored height held to the real range.

    Written as `max(MIN, min(ceiling, px))` rather than the shorter
    `min(max(px, MIN), ceiling)`: the two agree only while the ceiling is
    itself at least MIN, and that is an invariant of today's numbers rather
    than of the rule. */
export function clampDrawerHeight(px: number, maxHeight: number): number {
  const ceiling = Math.min(MAX_DRAWER_HEIGHT, Math.max(maxHeight, MIN_DRAWER_HEIGHT));
  return Math.round(Math.max(MIN_DRAWER_HEIGHT, Math.min(ceiling, px)));
}

/** Mid-drag the edge follows the pointer past the settings floor, all the way
    down to the shelf — pinning at the minimum while the pointer keeps going
    reads as the handle slipping — and only the release decides between
    commit, collapse and maximize. */
export function liveHeightFor(raw: number, collapsedHeight: number, fullHeight: number): number {
  return Math.round(Math.max(collapsedHeight, Math.min(fullHeight, raw)));
}

/** Whether the gesture ever really moved, and where the edge ended up in raw
    pixels — before any clamping. */
export interface ResizeGesture {
  moved: boolean;
  raw: number;
}

export type ResizeRelease =
  | { kind: 'toggle' }
  | { kind: 'collapse' }
  | { kind: 'maximize' }
  | { kind: 'commit'; height: number }
  | { kind: 'none' };

/** What releasing the shelf means.

    ⚠ The `!collapsed` guards are load-bearing and must not be folded away.
    `collapsed` round-trips through the settings push, so it lags inside a
    single gesture: a drag up from the shelf asks for `onSetCollapsed(false)`
    mid-move and still reads `true` here milliseconds later. */
export function resizeRelease(
  gesture: ResizeGesture,
  ctx: {
    collapsed: boolean;
    fullHeight: number;
    liveHeight: number | null;
    height: number;
    maxHeight: number;
  },
): ResizeRelease {
  if (!gesture.moved) {
    // A click anywhere on the shelf: toggle between it and the stored
    // height. One surface, one pair of gestures — drag resizes, click
    // toggles — whether the pointer landed on the grip or on the band.
    return { kind: 'toggle' };
  }
  if (!ctx.collapsed && gesture.raw < ctx.fullHeight * COLLAPSE_FRACTION) {
    // Released in the bottom tenth: close instead of pinning to the
    // minimum, keeping the stored height for the reopen.
    return { kind: 'collapse' };
  }
  if (!ctx.collapsed && gesture.raw > ctx.fullHeight * MAXIMIZE_FRACTION) {
    // Released in the top fifth: snap the rest of the way to full height.
    return { kind: 'maximize' };
  }
  if (!ctx.collapsed && ctx.liveHeight !== null) {
    // The live height may sit below the settings floor (the drag follows
    // the pointer); what is stored is held to the real range.
    const next = clampDrawerHeight(ctx.liveHeight, ctx.maxHeight);
    if (next !== ctx.height) return { kind: 'commit', height: next };
  }
  return { kind: 'none' };
}

export type ResizeKeyAction =
  | { kind: 'toggle' }
  | { kind: 'expand' }
  | { kind: 'collapse' }
  | { kind: 'step'; px: number }
  /** One of ours, but nothing to do — still claimed, so the page does not
      scroll under an arrow key aimed at the drawer. */
  | { kind: 'none' }
  /** Not a key this control answers: let it through untouched. */
  | { kind: 'ignore' };

/** Keyboard counterpart: arrows step the height (up from collapsed
    reopens), Enter/Space toggles the collapse like a click. */
export function resizeKeyAction(
  key: string,
  ctx: { collapsed: boolean; shownHeight: number },
): ResizeKeyAction {
  if (key === 'Enter' || key === ' ') return { kind: 'toggle' };
  const step = key === 'ArrowUp' ? HEIGHT_STEP : key === 'ArrowDown' ? -HEIGHT_STEP : 0;
  if (step === 0) return { kind: 'ignore' };
  if (ctx.collapsed) return step > 0 ? { kind: 'expand' } : { kind: 'none' };
  if (step < 0 && ctx.shownHeight <= MIN_DRAWER_HEIGHT) return { kind: 'collapse' };
  return { kind: 'step', px: step };
}

interface ResizeDeps {
  collapsed: () => boolean;
  height: () => number;
  maxHeight: () => number;
  /** Down to the shelf right now — the drawer's own answer, which folds in
      the drag that lowered it as well as the user's collapse. */
  sunk: () => boolean;
  onSetHeight: (px: number) => void;
  onSetCollapsed: (collapsed: boolean) => void;
}

interface Gesture extends ResizeGesture {
  pointerY: number;
  height: number;
  scale: number;
}

export class DrawerResize {
  /** The measured shelf box — exactly what a collapsed drawer is tall. */
  shelfHeight = $state(SHELF_FALLBACK);
  /** True mid-drag: the height must track the pointer 1:1, so the height
      transition (for click-collapse and keyboard steps) pauses. */
  resizing = $state(false);

  #live = $state<number | null>(null);
  /** Deliberately not `$state`: `moved` is written on every pointermove, and
      nothing renders it. */
  #from: Gesture | null = null;
  #deps: ResizeDeps;

  constructor(deps: ResizeDeps) {
    this.#deps = deps;
  }

  get collapsedHeight(): number {
    return Math.round(this.shelfHeight || SHELF_FALLBACK);
  }

  clamp(px: number): number {
    return clampDrawerHeight(px, this.#deps.maxHeight());
  }

  /** As tall as the clamp allows right now: the workspace's full height. */
  get fullHeight(): number {
    return this.clamp(Number.MAX_SAFE_INTEGER);
  }

  /** What the drawer is drawn at: the shelf while sunk, the pointer while
      dragging, the stored height at rest. */
  get shownHeight(): number {
    if (this.#deps.sunk()) return this.collapsedHeight;
    return this.#live !== null ? this.#live : this.clamp(this.#deps.height());
  }

  /** Spread on the shelf band — see the markup contract above. */
  get shelfAttrs(): HTMLAttributes<HTMLDivElement> {
    return {
      onpointerdown: this.#start,
      onpointermove: this.#move,
      onpointerup: this.#end,
      onpointercancel: this.#end,
      onlostpointercapture: this.#end,
    };
  }

  keydown = (e: KeyboardEvent): void => {
    const action = resizeKeyAction(e.key, {
      collapsed: this.#deps.collapsed(),
      shownHeight: this.shownHeight,
    });
    if (action.kind === 'ignore') return;
    e.preventDefault();
    if (action.kind === 'toggle') this.#deps.onSetCollapsed(!this.#deps.collapsed());
    else if (action.kind === 'expand') this.#deps.onSetCollapsed(false);
    else if (action.kind === 'collapse') this.#deps.onSetCollapsed(true);
    else if (action.kind === 'step')
      this.#deps.onSetHeight(this.clamp(this.shownHeight + action.px));
  };

  #start = (e: PointerEvent): void => {
    const shelf = e.currentTarget as HTMLElement;
    const target = e.target as HTMLElement | null;
    if (target?.closest(SHELF_CONTROLS)) return;
    // Pointer coordinates are window pixels; the drawer's height applies
    // inside its own chrome-scale zoom, so a pointer delta must be divided
    // back by that scale or a 150% chrome would resize half as fast. Read
    // off the drawer root — zoom does not inherit, so the shelf's own
    // computed zoom is always 1. (That class is a contract with the drawer's
    // own markup; it is named there for this reason.)
    const root = shelf.closest('.drawer-root') ?? shelf;
    const scale = Number(getComputedStyle(root).zoom) || 1;
    const base = this.#deps.collapsed() ? this.collapsedHeight : this.shownHeight;
    this.#from = { pointerY: e.clientY, height: base, scale, raw: base, moved: false };
    shelf.setPointerCapture(e.pointerId);
  };

  #move = (e: PointerEvent): void => {
    const from = this.#from;
    if (!from) return;
    const delta = (from.pointerY - e.clientY) / from.scale;
    if (Math.abs(delta) > CLICK_SLOP) from.moved = true;
    if (!from.moved) return;
    this.resizing = true;
    from.raw = from.height + delta;
    this.#live = liveHeightFor(from.raw, this.collapsedHeight, this.fullHeight);
    // Pulling up from the shelf is asking for the drawer back.
    if (this.#deps.collapsed() && from.raw > this.collapsedHeight + CLICK_SLOP)
      this.#deps.onSetCollapsed(false);
  };

  #end = (): void => {
    const gesture = this.#from;
    this.#from = null;
    this.resizing = false;
    if (!gesture) return;
    const action = resizeRelease(gesture, {
      collapsed: this.#deps.collapsed(),
      fullHeight: this.fullHeight,
      liveHeight: this.#live,
      height: this.#deps.height(),
      maxHeight: this.#deps.maxHeight(),
    });
    if (action.kind === 'toggle') this.#deps.onSetCollapsed(!this.#deps.collapsed());
    else if (action.kind === 'collapse') this.#deps.onSetCollapsed(true);
    else if (action.kind === 'maximize') this.#deps.onSetHeight(this.fullHeight);
    else if (action.kind === 'commit') this.#deps.onSetHeight(action.height);
    this.#live = null;
  };
}
