<script lang="ts">
  import { PRODUCT } from '$lib/site';

  /**
   * The one Plectrify lockup: the icon coin beside the Chakra Petch wordmark.
   * Header and footer both render this rather than assembling their own, so
   * the pair cannot drift — the wordmark size and the icon/text gap are both
   * derived from the icon edge, one ratio at every size it appears at.
   *
   * The mark is a 3D coin, not a flat img: front face, mirrored back face,
   * and four darkened slices between them faking an extruded rim. With
   * `interactive`, hovering the lockup spins it about its own vertical axis;
   * `spins` lets the parent accumulate extra half turns on top (the header
   * adds one each time the bar gains or loses its chrome). The glow filter
   * sits on the faces, not the wrapper — a filter on any ancestor flattens
   * preserve-3d and the coin would collapse flat.
   */
  interface Props {
    /** Icon edge in rem. The wordmark is 0.6× it, the gap 0.28×. */
    icon?: number;
    /** Accumulated half turns beyond hover, driven by the parent. */
    spins?: number;
    /** Spin and glow on hover — for the lockup that is a link. */
    interactive?: boolean;
  }

  let { icon = 2.25, spins = 0, interactive = false }: Props = $props();

  const px = $derived(Math.round(icon * 16));
</script>

<span
  class="brand flex items-center {interactive ? 'interactive' : ''}"
  style="--brand-icon: {icon}rem; --coin-spins: {spins}"
>
  <span class="coin shrink-0" aria-hidden="true">
    <span class="coin-inner block size-full">
      {#each [-1.5, -0.5, 0.5, 1.5] as z (z)}
        <img
          src="/icon-192.png"
          alt=""
          width={px}
          height={px}
          class="coin-rim"
          style="transform: translateZ({z}px)"
        />
      {/each}
      <img src="/icon-192.png" alt="" width={px} height={px} class="coin-face coin-front" />
      <img src="/icon-192.png" alt="" width={px} height={px} class="coin-face coin-back" />
    </span>
  </span>
  <!-- The wordmark is the one place the site sets Chakra Petch (see app.css).
       Its letterforms are already squared and snug, so it gets no tracking —
       Inter's compensating `tracking-tight` would close the letters up. -->
  <span class="wordmark font-wordmark font-semibold">{PRODUCT}</span>
</span>

<style>
  .brand {
    gap: calc(var(--brand-icon) * 0.28);
  }

  .wordmark {
    font-size: calc(var(--brand-icon) * 0.6);
  }

  .coin {
    width: var(--brand-icon);
    height: var(--brand-icon);
    perspective: 320px;
  }

  .coin-inner {
    position: relative;
    transform-style: preserve-3d;
    transform: rotateY(calc(var(--coin-spins, 0) * 180deg));
    transition: transform 600ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  .coin-inner img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* The rim slices are the same art squashed dark, so the silhouette reads
     as solid thickness edge-on instead of the faces briefly vanishing. */
  .coin-rim {
    filter: brightness(0.35);
  }

  .coin-face {
    backface-visibility: hidden;
    transition: filter 200ms;
  }

  .coin-front {
    transform: translateZ(2.5px);
  }

  .coin-back {
    transform: rotateY(180deg) translateZ(2.5px);
  }

  /* A half turn, easing out to rest on the opposite face — which carries the
     same art, so the mark still reads as itself. Leaving unwinds it. */
  .interactive:hover .coin-inner {
    transform: rotateY(calc((var(--coin-spins, 0) + 1) * 180deg));
  }

  .interactive:hover .coin-face {
    filter: drop-shadow(var(--shadow-glow-accent-sm));
  }

  @media (prefers-reduced-motion: reduce) {
    .coin-inner {
      transition: none;
    }
  }
</style>
