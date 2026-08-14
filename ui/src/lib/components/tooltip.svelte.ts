/**
 * The app's only tooltip mechanism — native `title` attributes are not used
 * anywhere, because the OS renders them unstyled, on its own slow schedule,
 * and (inside WebView2) sometimes not at all.
 *
 * Usage is an attachment, so any element can get one without being wrapped:
 *
 * ```svelte
 * <button {@attach tooltip('Remove module')}>…</button>
 * <span {@attach tooltip(name, { placement: 'right' })}>…</span>
 * ```
 *
 * A single tooltip is visible at a time; `TooltipLayer` (mounted once in
 * `App.svelte`) renders whatever is active here.
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipOptions {
  /** Preferred side; defaults to below the anchor. Flips to the opposite side
      when it would go off-screen. */
  placement?: TooltipPlacement;
  /** Hover dwell before showing, in ms. */
  delay?: number;
  /** Selector for an ancestor to place the panel against instead of the
      hovered element, so the arrow can land on an enclosing box's edge — a
      module title hovers, but its tooltip hangs off the card's own border
      rather than floating inside the header. */
  positionFrom?: string;
}

export interface ActiveTooltip {
  text: string;
  /** The hovered element; also the identity behind "is this tooltip mine?". */
  anchor: HTMLElement;
  /** What the panel is placed against — the anchor unless `positionFrom`
      pointed at an ancestor. */
  positionAnchor: HTMLElement;
  placement: TooltipPlacement;
}

const SHOW_DELAY = 400;
/** Moving between neighbouring controls inside this window shows instantly,
    the way native tooltips stay "warm" once the first one has appeared. */
const WARM_WINDOW = 400;

let active = $state.raw<ActiveTooltip | null>(null);
let showTimer: ReturnType<typeof setTimeout> | undefined;
let lastHiddenAt = -Infinity;

/** The tooltip currently showing, if any. Read by `TooltipLayer`. */
export function activeTooltip(): ActiveTooltip | null {
  return active;
}

function cancelPending() {
  clearTimeout(showTimer);
  showTimer = undefined;
}

/** Dismiss whatever is showing — also used by anything that moves the anchor
    out from under the pointer (menus opening, scrolling, the rack panning). */
export function hideTooltip() {
  cancelPending();
  if (active === null) return;
  lastHiddenAt = performance.now();
  active = null;
}

export function tooltip(
  text: string | null | undefined,
  options: TooltipOptions = {},
): Attachment<HTMLElement> {
  return (node) => {
    if (!text) return;

    const label = text;
    const isMine = () => active?.anchor === node;

    // Built fresh each time rather than once up front: `positionFrom` resolves
    // against the live DOM, and the ancestor it names can be replaced while the
    // anchor itself stays put.
    const describe = (): ActiveTooltip => ({
      text: label,
      anchor: node,
      positionAnchor:
        (options.positionFrom ? node.closest<HTMLElement>(options.positionFrom) : null) ?? node,
      placement: options.placement ?? 'bottom',
    });

    // The attachment re-runs when `text` changes; keep a visible tooltip in
    // sync rather than leaving stale text on screen (e.g. a bypass toggle
    // flipping between "Turn on" and "Turn off" under the pointer).
    //
    // Untracked, and this must stay the only read of `active` in the
    // attachment body: a tracked read makes showing a tooltip re-run this
    // attachment, whose teardown then hides the tooltip that just opened.
    untrack(() => {
      if (isMine()) active = describe();
    });

    function open() {
      cancelPending();
      active = describe();
    }

    function scheduleOpen() {
      if (isMine()) return;
      cancelPending();
      if (performance.now() - lastHiddenAt < WARM_WINDOW) open();
      else showTimer = setTimeout(open, options.delay ?? SHOW_DELAY);
    }

    function dismiss() {
      cancelPending();
      if (isMine()) hideTooltip();
    }

    function onPointerEnter(e: PointerEvent) {
      // Touch already long-presses into a context menu; don't fight it.
      if (e.pointerType !== 'touch') scheduleOpen();
    }

    function onFocusIn() {
      // Only for keyboard focus — a click focuses the button too, and a
      // tooltip popping up on the thing you just pressed is noise.
      if (node.matches(':focus-visible')) open();
    }

    node.addEventListener('pointerenter', onPointerEnter);
    node.addEventListener('pointerleave', dismiss);
    node.addEventListener('pointercancel', dismiss);
    // Acting on a control means its tooltip has done its job.
    node.addEventListener('pointerdown', dismiss);
    node.addEventListener('focusin', onFocusIn);
    node.addEventListener('focusout', dismiss);

    return () => {
      node.removeEventListener('pointerenter', onPointerEnter);
      node.removeEventListener('pointerleave', dismiss);
      node.removeEventListener('pointercancel', dismiss);
      node.removeEventListener('pointerdown', dismiss);
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', dismiss);
      dismiss();
    };
  };
}
