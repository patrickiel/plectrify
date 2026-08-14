<script lang="ts">
  import fullLogo from '../../lib/assets/tone3000/tone3000-logo.svg';
  import compactMark from '../../lib/assets/tone3000/t3k-mark.svg';

  /**
   * TONE3000's own marks, used under their integration requirements.
   *
   * There are two, and which one goes where is a rule rather than a
   * preference: **the full TONE3000 logo must be seen before the compact T3K
   * mark**, so that T3K means something by the time it appears. Full logo at
   * entry points — the partnership splash, the drawer's browse tile, the
   * panel header. Compact mark only afterwards, in buttons and as the origin
   * marker on a module card or a patch tile. Never both in one view.
   *
   * Please don't "simplify" this by using one everywhere; the rule is theirs,
   * and integration sign-off depends on it.
   *
   * The artwork is TONE3000's trademark, reproduced verbatim from the files
   * they publish: never recoloured, re-drawn, stretched, or set on a
   * background that fights it. Both are sized from their own aspect ratio —
   * only `height` is given, so nothing here can distort them.
   *
   * Which is why the **light theme gets a dark plate** rather than a tweaked
   * logo. Both files are pure #FF0000 / #0000FF / #FFFF00 on nothing: drawn for
   * a dark ground, and on a white card the yellow all but vanishes and the blue
   * loses its edge. The one fix that leaves the trademark untouched is to give
   * it the ground it was drawn for — a small near-black plate with its own
   * clear space, sized from `height` so it hugs the artwork at every density.
   * Dark theme needs none and gets none.
   */
  interface Props {
    /** 'full' is the TONE3000 wordmark; 'mark' is the compact T3K badge. */
    variant?: 'full' | 'mark';
    /** Rendered height in pixels. The width follows the artwork. */
    height?: number;
    class?: string;
  }

  let { variant = 'full', height = 20, class: className = '' }: Props = $props();

  const source = $derived(variant === 'mark' ? compactMark : fullLogo);
  /* Clear space in proportion to the mark, floored so a 9 px mark in the patch
     menu still reads as a plate rather than as a hairline. */
  const pad = $derived(Math.max(2, Math.round(height * 0.22)));
</script>

<span
  class={['t3k-plate inline-flex w-auto items-center', className]}
  style:--t3k-pad="{pad}px"
  style:--t3k-radius="{pad + 2}px"
>
  <img
    src={source}
    alt="TONE3000"
    style:height="{height}px"
    class="w-auto select-none"
    draggable="false"
  />
</span>

<style>
  /* Unlayered and theme-scoped, same convention as app.css's light block: the
     plate exists only where the page is light. */
  :global(:root[data-theme='light']) .t3k-plate {
    /* A slate rather than a black: near-black punched a hole in the card. This
       is as light as the plate can go and still carry the artwork — the logo's
       blue is #0000FF, itself a dark colour, so lifting the ground much further
       is what starts to lose it. */
    background: #232a38;
    border-radius: var(--t3k-radius);
    padding: calc(var(--t3k-pad) * 0.6) var(--t3k-pad);
    /* No hairline and only the faintest drop: the chip should settle onto the
       card, not sit proud of it. */
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
  }
</style>
