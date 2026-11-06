<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cn } from '../../lib/components/classNames';
  import { slideoutShift } from './slideoutFit';

  /**
   * What the status bar's slideouts have in common: a panel floating a small
   * gap above the bar, centred on the control that opened it, with an arrow on
   * its lower edge pointing back at that control. The tuner, mute and gate
   * panels supply their rows and their width; the gap, the arrow and the fit
   * inside the window live here so the three cannot drift apart.
   *
   * Must be rendered directly inside the control's positioned zone: that zone is
   * what `left-1/2` centres on, and what keeps the panel open while hovered.
   */
  interface Props {
    /** Sizing, merged over the panel's own classes. */
    class?: string;
    children: Snippet;
  }

  let { class: className, children }: Props = $props();

  /** Keep-out margin against the window's edges, in the panel's own pixels. */
  const WINDOW_MARGIN = 8;

  /** Centred on the control, a panel can run off the window: the gate's is
      wider than the distance from its pill to the left edge at most sizes. So
      measure once laid out and shift it just far enough back in. `--shift` moves
      the panel and, in the opposite direction, the arrow, which is what holds
      the arrow on the control.

      The bar carries CSS `zoom`, so a rect's units are not `--shift`'s, and which
      units a rect comes back in has varied by engine and version; this page also
      runs on WebKit. So assume neither: the bounds are the bar's own rect, the
      window's width in whatever units the panel's rect is in, and the ratio of a
      rect's width to `offsetWidth` converts the answer to the pixels `--shift` is
      applied in. */
  function keepInWindow(node: HTMLElement) {
    const bar = node.closest('footer');
    if (!bar) return;
    const fit = () => {
      node.style.setProperty('--shift', '0px');
      const rect = node.getBoundingClientRect();
      const scale = rect.width / node.offsetWidth || 1;
      const shift = slideoutShift(rect, bar.getBoundingClientRect(), WINDOW_MARGIN * scale);
      node.style.setProperty('--shift', `${shift / scale}px`);
    };
    fit();
    // The tuner's panel changes width with its display mode, so watching the
    // window alone would leave a stale shift behind.
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }
</script>

<!-- Opaque, unlike the bar it floats above: the arrow's fill has to hide the
     panel's border where they meet, and a translucent fill would show that
     border through it and double up where it overlaps the panel. -->
<div
  class={cn(
    'absolute bottom-[calc(100%+var(--slideout-gap))] left-1/2 z-60 flex max-w-[calc((100vw-1rem)/var(--ui-scale,1))] translate-x-[calc(-50%+var(--shift,0px))] flex-col gap-[.1rem] rounded-[.4rem] border border-[color:color-mix(in_srgb,var(--color-ink)_calc(18%_*_var(--ink-k)),transparent)] bg-chrome-solid px-[.4rem] py-[.35rem] font-mono text-[length:var(--footer-font-size)] font-[650] text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)] shadow-[0_-4px_18px_color-mix(in_srgb,var(--color-void)_35%,transparent)] [--slideout-gap:.6rem]',
    className,
  )}
  transition:fly={{ y: 8, duration: 140 }}
  {@attach keepInWindow}
>
  {@render children()}

  <!-- The hover bridge. The panel closes when the pointer leaves the bar and
       everything inside it, so the gap would close it on the way up from the
       control. This is part of the panel, so crossing the gap never leaves. It
       spans the panel's width because the trip up is rarely straight, and runs
       a few pixels into the bar so that no rounding at a fractional UI scale can
       open a one-pixel hole between the two. -->
  <span class="absolute inset-x-0 top-full h-[calc(var(--slideout-gap)+3px)]" aria-hidden="true"
  ></span>

  <!-- The arrow: a square rotated 45° so its right and bottom borders form the
       point, centred on the panel's lower border so its fill hides that border
       behind it (the tooltip's arrow, see TooltipLayer). Clamped clear of the
       rounded corners for a control right at the window's edge. -->
  <span
    class="pointer-events-none absolute bottom-[calc(-.3rem-.5px)] left-[clamp(.75rem,calc(50%-var(--shift,0px)),calc(100%-.75rem))] size-[.6rem] -translate-x-1/2 rotate-45 border-r border-b border-[color:color-mix(in_srgb,var(--color-ink)_calc(18%_*_var(--ink-k)),transparent)] bg-chrome-solid"
    aria-hidden="true"
  ></span>
</div>
