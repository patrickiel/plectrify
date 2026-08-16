<script lang="ts">
  import { activeTooltip, hideTooltip, type ActiveTooltip } from './tooltip.svelte';

  /**
   * Renders the single active tooltip. Mounted once, at the end of
   * `App.svelte`, so it paints above every panel and escapes the rack's
   * overflow clip; anchors register themselves through the `tooltip()`
   * attachment in `tooltip.svelte.ts`.
   */
  /** Distance from the anchor — exactly how far the arrow reaches past the
      panel's edge (see `.tooltip::after`), so its tip lands on the anchor
      instead of pointing at it across a gap. */
  const GAP = 6;
  const EDGE = 6; // keep-out margin against the viewport edge
  /** How far the arrow's centre must stay from a corner, so it never lands on
      the panel's rounded edge. */
  const ARROW_INSET = 12;

  const active = $derived(activeTooltip());

  function clamp(value: number, max: number) {
    return Math.min(Math.max(value, EDGE), Math.max(EDGE, max));
  }

  /** Places the panel against its anchor. Positioning has to happen here
      rather than in a $derived: it needs the rendered panel's own size, which
      only exists once the node is in the DOM. */
  function place(current: ActiveTooltip) {
    return (node: HTMLElement) => {
      const a = current.positionAnchor.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = node;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Flip to the opposite side when the preferred one doesn't fit.
      let placement = current.placement;
      if (placement === 'top' && a.top - GAP - h < EDGE) placement = 'bottom';
      else if (placement === 'bottom' && a.bottom + GAP + h > vh - EDGE) placement = 'top';
      else if (placement === 'left' && a.left - GAP - w < EDGE) placement = 'right';
      else if (placement === 'right' && a.right + GAP + w > vw - EDGE) placement = 'left';

      const vertical = placement === 'top' || placement === 'bottom';
      const left = vertical
        ? a.left + a.width / 2 - w / 2
        : placement === 'left'
          ? a.left - GAP - w
          : a.right + GAP;
      const top = vertical
        ? placement === 'top'
          ? a.top - GAP - h
          : a.bottom + GAP
        : a.top + a.height / 2 - h / 2;

      const placedLeft = clamp(left, vw - w - EDGE);
      const placedTop = clamp(top, vh - h - EDGE);
      node.style.left = `${placedLeft}px`;
      node.style.top = `${placedTop}px`;

      // The arrow tracks the anchor's centre rather than the panel's, so it
      // still points at the control after the panel is clamped to the viewport.
      node.dataset.placement = placement;
      const arrowAxis = vertical
        ? { name: '--arrow-x', value: a.left + a.width / 2 - placedLeft, extent: w }
        : { name: '--arrow-y', value: a.top + a.height / 2 - placedTop, extent: h };
      node.style.setProperty(
        arrowAxis.name,
        `${Math.min(Math.max(arrowAxis.value, ARROW_INSET), Math.max(ARROW_INSET, arrowAxis.extent - ARROW_INSET))}px`,
      );
      // Next frame, so the fade-in has an unplaced first frame to run from
      // instead of the browser collapsing both states into one paint.
      const frame = requestAnimationFrame(() => node.classList.add('ready'));
      return () => cancelAnimationFrame(frame);
    };
  }
</script>

<!-- Anything that moves an anchor out from under the pointer without a
     pointerleave (rack panning, zooming, a menu opening) would otherwise
     strand the tooltip beside empty space. -->
<svelte:window
  onscrollcapture={hideTooltip}
  onwheelcapture={hideTooltip}
  onresize={hideTooltip}
  onblur={hideTooltip}
  onkeydown={(e) => e.key === 'Escape' && hideTooltip()}
/>

{#if active !== null}
  <div
    role="tooltip"
    class="tooltip pointer-events-none fixed z-[100] max-w-72 scale-[.96] rounded-control-sm border border-accent bg-menu px-[.6rem] py-[.3rem] text-center text-[length:var(--ctl-text)] leading-[1.35] font-semibold tracking-[.01em] text-balance text-ink opacity-0 shadow-[0_6px_18px_color-mix(in_srgb,var(--color-void)_70%,transparent),var(--shadow-glow-accent-sm)] [--arrow-x:50%] [--arrow-y:50%] [transition:opacity_110ms_ease,scale_110ms_ease] motion-reduce:scale-100 motion-reduce:transition-none [&.ready]:scale-100 [&.ready]:opacity-100"
    {@attach place(active)}
  >
    {active.text}
  </div>
{/if}

<style>
  /* The arrow is the chip's own corner: a square sharing its fill and outline,
     rotated 45° so exactly two borders form the visible point, and its fill
     masks the chip's border behind it. Which two borders depends on the side
     it hangs off, set by `place` as [data-placement]. */
  .tooltip::after {
    content: '';
    position: absolute;
    width: 9px;
    height: 9px;
    background: inherit;
    border: 0 solid var(--color-accent);
    transform: rotate(45deg);
  }

  .tooltip:global([data-placement='bottom'])::after {
    top: -5px;
    left: var(--arrow-x);
    margin-left: -4.5px;
    border-top-width: 1px;
    border-left-width: 1px;
  }

  .tooltip:global([data-placement='top'])::after {
    bottom: -5px;
    left: var(--arrow-x);
    margin-left: -4.5px;
    border-bottom-width: 1px;
    border-right-width: 1px;
  }

  .tooltip:global([data-placement='right'])::after {
    left: -5px;
    top: var(--arrow-y);
    margin-top: -4.5px;
    border-bottom-width: 1px;
    border-left-width: 1px;
  }

  .tooltip:global([data-placement='left'])::after {
    right: -5px;
    top: var(--arrow-y);
    margin-top: -4.5px;
    border-top-width: 1px;
    border-right-width: 1px;
  }
</style>
