<script module lang="ts">
  interface StackEntry {
    contains: (node: Node) => boolean;
    close: () => void;
  }

  /** Every open popover, in the order they opened. A popover nested inside
      another — a Select inside the setup menu — always opens after its host, so
      this doubles as the ancestor chain. */
  const openStack: StackEntry[] = [];

  /**
   * Close every popover opened after the innermost one containing `target`.
   *
   * Panels are portaled to <body>, so a nested popover's panel is *not* inside
   * its host's panel in the DOM. Judged on containment alone every click on a
   * nested menu reads as an outside click and closes the host, which destroys
   * the nested popover before its own click can land — the menu appears to
   * ignore the selection. Ordering is what recovers the nesting the DOM lost.
   */
  function dismissOutside(target: Node) {
    let ownerIndex = -1;
    for (let i = openStack.length - 1; i >= 0; i--) {
      if (openStack[i].contains(target)) {
        ownerIndex = i;
        break;
      }
    }
    // Iterate a copy: close() feeds back into the effect that owns the stack.
    for (const entry of openStack.slice(ownerIndex + 1).reverse()) entry.close();
  }
</script>

<script lang="ts">
  import { createAttachmentKey } from 'svelte/attachments';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { Snippet } from 'svelte';

  /**
   * The one popover implementation behind Select and the patch/rig menus.
   * Owns everything those menus used to copy-paste: the
   * body portal, viewport positioning with flip-up, outside-click dismissal,
   * and the panel chrome. The consumer renders its own trigger button
   * (spreading `props` onto it, so scoped styles keep working) and the panel
   * contents.
   */
  interface Props {
    /** Whether the panel is showing. Bind it to close programmatically
        (assign `false`); opening must go through the trigger so the panel
        gets positioned. */
    open?: boolean;
    /** Panel height cap in px; also drives the flip-up decision. */
    maxHeight: number;
    /** Pixel gap between the trigger and the panel. */
    gap?: number;
    /** Give the panel the trigger's width as a minimum. */
    matchTriggerWidth?: boolean;
    /** Open above the trigger when there's room (a trigger docked over its
        content, where dropping down would cover it); falls back to below. */
    preferUp?: boolean;
    /** Extra panel classes (e.g. a fixed width like `w-56`). */
    panelClass?: string;
    ariaHasPopup?: 'listbox' | 'menu' | 'dialog';
    /** Reset per-open UI state here; runs right before the panel shows. */
    onOpen?: () => void;
    /** The consumer's own trigger button. Spread the first argument onto it
        so the popover can wire toggling, keyboard and outside-click handling;
        the second argument is the current open state (for active styling). */
    trigger: Snippet<[Record<string, unknown>, boolean]>;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    maxHeight,
    gap = 0,
    matchTriggerWidth = false,
    preferUp = false,
    panelClass = '',
    ariaHasPopup = 'listbox',
    onOpen,
    trigger,
    children,
  }: Props = $props();

  let triggerEl: HTMLElement | undefined = $state();
  let panelEl: HTMLElement | undefined = $state();

  /** Gap kept between the panel and the edge of the window. */
  const VIEWPORT_MARGIN = 8;

  // The panel is position:fixed (viewport-relative) so it escapes the rack's
  // overflow clip. Coordinates are snapshotted from the trigger on open.
  // `maxHeight` is the prop clamped to the space on the chosen side, so a
  // trigger low in the window gets a shorter, scrolling panel instead of one
  // clipped by the window edge.
  let placement = $state({ left: 0, top: 0, bottom: 0, width: 0, flipUp: false, maxHeight: 0 });

  // Move the fixed-position panel to <body>. An ancestor with backdrop-filter
  // (e.g. a module card) otherwise becomes the containing block for
  // position:fixed, offsetting the panel by that ancestor's box.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    panelEl = node;
    clampIntoViewport(node);
    return () => {
      panelEl = undefined;
      node.remove();
    };
  }

  // Slide the panel back inside the window when the trigger sits close enough
  // to the right edge that a left-aligned panel would hang off it — the
  // horizontal counterpart of the flip-up above. The panel's width is only
  // knowable once it exists, hence doing this from the attachment; it runs
  // before the browser paints, so the corrected position is the first one seen.
  function clampIntoViewport(node: HTMLElement) {
    const rightmost = window.innerWidth - node.offsetWidth - VIEWPORT_MARGIN;
    const left = Math.min(placement.left, Math.max(VIEWPORT_MARGIN, rightmost));
    if (left !== placement.left) placement = { ...placement, left };
  }

  function openPanel() {
    if (triggerEl === undefined) return;
    const r = triggerEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const flipUp = preferUp
      ? r.top >= spaceBelow || r.top - gap - VIEWPORT_MARGIN >= maxHeight
      : spaceBelow < maxHeight && r.top > spaceBelow;
    const available = (flipUp ? r.top : spaceBelow) - gap - VIEWPORT_MARGIN;
    placement = {
      left: r.left,
      top: r.bottom + gap,
      bottom: window.innerHeight - r.top + gap,
      width: r.width,
      flipUp,
      maxHeight: Math.min(maxHeight, available),
    };
    onOpen?.();
    open = true;
  }

  function close() {
    open = false;
  }

  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      openPanel();
    }
  }

  const stackEntry: StackEntry = {
    contains: (node) => !!triggerEl?.contains(node) || !!panelEl?.contains(node),
    close: () => close(),
  };

  $effect(() => {
    if (!open) return;
    openStack.push(stackEntry);
    return () => {
      const index = openStack.indexOf(stackEntry);
      if (index >= 0) openStack.splice(index, 1);
    };
  });

  function onWindowPointerDown(e: PointerEvent) {
    // Every open popover has this listener, but the sweep is global — so only
    // the innermost one runs it, and the stack is walked once per click.
    if (!open || openStack[openStack.length - 1] !== stackEntry) return;
    dismissOutside(e.target as Node);
  }

  /**
   * Escape closes the innermost open popover, one layer per press.
   *
   * Panel contents that give Escape their own meaning — cancelling an inline
   * rename, say — claim it by calling `preventDefault()`, which keeps that
   * press from also dismissing the menu around them.
   */
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!open || openStack[openStack.length - 1] !== stackEntry) return;
    e.preventDefault();
    close();
    // The panel may hold the focus (a menu can autofocus a filter or rename
    // box), and it is about to be removed — hand focus back to the trigger
    // rather than let it fall to <body>. preventScroll: the trigger can sit in
    // a scrolled rack, and refocusing it must not jump the view.
    triggerEl?.focus({ preventScroll: true });
  }

  /**
   * Grow the panel out of the trigger's near corner, and shrink back on close.
   *
   * Only `transform` is animated — the horizontal placement rides the separate
   * `translate` property (see the panel below), which composes *around* the
   * transform rather than being replaced by the transition's keyframes.
   */
  function popover(_node: Element, { closing = false } = {}) {
    const shift = placement.flipUp ? 4 : -4;
    return {
      duration: prefersReducedMotion.current ? 0 : closing ? 90 : 140,
      easing: cubicOut,
      css: (t: number, u: number) =>
        `opacity: ${t};
         transform: translateY(${shift * u}px) scale(${0.96 + 0.04 * t});
         ${closing ? 'pointer-events: none;' : ''}`,
    };
  }

  const triggerKey = createAttachmentKey();
  const triggerProps = $derived({
    type: 'button',
    'aria-haspopup': ariaHasPopup,
    'aria-expanded': open,
    onclick: () => (open ? close() : openPanel()),
    onkeydown: onTriggerKeydown,
    [triggerKey]: (node: HTMLElement) => {
      triggerEl = node;
      return () => (triggerEl = undefined);
    },
  });
</script>

<!-- Capture before rack panning can stop the event on background clicks. -->
<svelte:window onpointerdowncapture={onWindowPointerDown} onkeydown={onWindowKeydown} />

{@render trigger(triggerProps, open)}

{#if open}
  <!-- Above the dialog layer (z-60..67), not below it: a menu is transient and
       belongs to whatever is topmost when it opens, and a trigger behind a
       modal scrim cannot be clicked in the first place. At z-50 a Select inside
       a dialog opened *behind the card* — present, focusable, invisible.
       Tooltips (z-100) and the window resize strips (z-1000) stay above.

       Placed with left:0 + a translation rather than a `left` offset: a panel
       with an auto width shrinks to the space between `left` and the window
       edge, so offsetting it directly would make a near-the-edge panel narrow —
       and measure that narrowed width in clampIntoViewport. Anchored at 0 it
       always lays out at its natural width, and the translation moves it into
       place. That translation uses the standalone `translate` property, leaving
       `transform` free for the open/close animation: `translate` is applied
       after `transform`, so the panel scales about its own corner and *then*
       moves, instead of having its offset scaled along with it. -->
  <div
    {@attach portal}
    class="fixed z-80 flex flex-col overflow-hidden rounded-md border border-ink/20 bg-menu/95 shadow-panel backdrop-blur-xl {panelClass}"
    style:left="0"
    style:translate="{placement.left}px 0"
    style:transform-origin={placement.flipUp ? 'bottom left' : 'top left'}
    style:top={placement.flipUp ? 'auto' : `${placement.top}px`}
    style:bottom={placement.flipUp ? `${placement.bottom}px` : 'auto'}
    style:min-width={matchTriggerWidth ? `${placement.width}px` : undefined}
    style:max-width="calc(100vw - {VIEWPORT_MARGIN * 2}px)"
    style:max-height="{placement.maxHeight}px"
    in:popover
    out:popover={{ closing: true }}
  >
    {@render children()}
  </div>
{/if}
