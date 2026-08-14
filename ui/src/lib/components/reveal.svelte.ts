import { onMount } from 'svelte';
import { cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';

/**
 * The motion behind a tool panel's progressive disclosure — Simple/Expert on
 * the looper and metronome, Perform/Edit on the songs panel.
 *
 * Each is one switch that reveals or hides whole rows at once, so without a
 * transition the panel jumps and the eye has to re-find what moved. Blocks that
 * change the panel's height slide (the height *is* the motion, so the rows below
 * travel with them); controls that appear inside a row which was already there
 * fade, because sliding a button would shove its neighbours sideways for no
 * reason.
 *
 * Call it once per component, during init:
 *
 * ```svelte
 * const reveal = createReveal();
 * …
 * <div transition:slide={reveal.slide()}>
 * ```
 *
 * **Nothing animates on mount.** A `transition:` directive plays its intro when
 * the element is created, which for these panels means every *opening* of the
 * sidebar — and every switch between tools — would unfold the setup rows the
 * user never touched, on top of the panel's own fly-in. So the durations stay
 * at zero until the component has mounted, and only a real toggle afterwards
 * moves. The parameters are read when a transition starts, which is also why
 * `prefers-reduced-motion` is consulted here rather than at module load.
 */
export function createReveal() {
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  const duration = (ms: number) => (mounted && !prefersReducedMotion.current ? ms : 0);

  return {
    /** For a block whose appearance changes the panel's height. */
    slide: () => ({ duration: duration(160), easing: cubicOut }),
    /** For a control appearing inside a row that stays put. */
    fade: () => ({ duration: duration(120), easing: cubicOut }),
  };
}
