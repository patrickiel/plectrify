<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type {
    NeedlePrecision,
    StrobePrecision,
    TunerDisplayMode,
    TunerReading,
  } from '../../lib/engine/types';
  import StrobeDisplay from './StrobeDisplay.svelte';
  import { needleOffset, needleTickPercents } from './needle';
  import { strobeMultipliers } from './strobe';

  interface Props {
    /** Whether this surface should expose the detector's current reading. */
    active: boolean;
    reading: TunerReading;
    display: TunerDisplayMode;
    strobePrecision: StrobePrecision;
    needlePrecision: NeedlePrecision;
    reduceMotion: boolean;
    /** The status-bar readout or the enlarged live-performance presentation. */
    variant?: 'compact' | 'stage';
  }

  let {
    active,
    reading,
    display,
    strobePrecision,
    needlePrecision,
    reduceMotion,
    variant = 'compact',
  }: Props = $props();

  type DetectedReading = Extract<TunerReading, { detected: true }>;
  let heldReading = $state<DetectedReading | undefined>();
  let readingVisible = $state(false);
  let displayedCents = $state(0);
  let targetCents = 0;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let animationFrame: number | undefined;

  const strobeMode = $derived(display === 'strobe' && !reduceMotion);
  const strobeRows = $derived(strobeMultipliers(strobePrecision));
  const needleTicks = $derived(needleTickPercents(needlePrecision));
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const tuner = $derived.by(() => {
    const current = heldReading;
    if (!active || current === undefined)
      // Blank, not a placeholder dash: the grid columns hold their width on
      // their own, so "no note" reads as quiet rather than as a glyph.
      return { note: '', cents: 0, ready: false, tuneMix: 0, close: false };

    const cents = Math.round(current.cents);
    const distance = Math.abs(current.cents);
    return {
      note: `${noteNames[(current.midiNote + 120) % 12]}${Math.floor(current.midiNote / 12) - 1}`,
      cents,
      ready: true,
      tuneMix: Math.round(Math.max(0, Math.min(1, (3 - distance) / 2)) * 100),
      close: distance <= 10,
    };
  });

  function clearTimers() {
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    if (resetTimer !== undefined) clearTimeout(resetTimer);
    fadeTimer = undefined;
    resetTimer = undefined;
  }

  function hideReading(immediately: boolean) {
    clearTimers();
    if (immediately) {
      readingVisible = false;
      heldReading = undefined;
      targetCents = 0;
      displayedCents = 0;
      return;
    }

    fadeTimer = setTimeout(() => {
      readingVisible = false;
      fadeTimer = undefined;
      resetTimer = setTimeout(() => {
        heldReading = undefined;
        targetCents = 0;
        resetTimer = undefined;
      }, 150);
    }, 300);
  }

  onMount(() => {
    let previousTime = performance.now();
    const animate = (time: number) => {
      const elapsed = Math.min(50, time - previousTime);
      previousTime = time;
      const difference = targetCents - displayedCents;

      // StrobeDisplay owns its compositor loop. The needle either follows the
      // reading directly for reduced motion or eases just enough to reject DSP
      // scatter without lagging behind a player's adjustment.
      if (!strobeMode) {
        if (reduceMotion) {
          if (displayedCents !== targetCents) displayedCents = targetCents;
        } else if (Math.abs(difference) > 0.25) {
          const alpha = 1 - Math.exp(-elapsed / 85);
          displayedCents += difference * alpha;
        } else if (displayedCents !== targetCents) {
          displayedCents = targetCents;
        }
      }

      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
  });

  onDestroy(() => {
    clearTimers();
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  });

  $effect(() => {
    const current = reading;
    if (!active) {
      hideReading(true);
    } else if (current.detected) {
      clearTimers();
      heldReading = current;
      targetCents = Math.max(-50, Math.min(50, current.cents));
      readingVisible = true;
    } else if (heldReading !== undefined && fadeTimer === undefined && resetTimer === undefined) {
      hideReading(false);
    }
  });
</script>

<span
  class={[
    'grid min-w-0 items-center',
    variant === 'stage'
      ? 'stage w-[min(calc(100vw-3rem),90rem)] grid-cols-[minmax(5rem,.75fr)_minmax(15rem,5fr)_minmax(5rem,.75fr)] gap-[clamp(1rem,3vw,3rem)]'
      : 'w-full grid-cols-[2.2rem_minmax(5rem,1fr)_1.9rem] gap-1 max-[860px]:grid-cols-[2rem_minmax(4rem,1fr)_1.9rem] max-[860px]:gap-[.2rem] max-[620px]:grid-cols-[2rem_minmax(4rem,1fr)] max-[620px]:gap-1',
  ]}
  style:--tune-mix={`${tuner.tuneMix}%`}
>
  <span
    class="note text-center font-mono text-[length:var(--footer-font-size,.75rem)] leading-normal font-bold tracking-[.08em] text-[color:color-mix(in_srgb,color-mix(in_srgb,var(--color-ink)_calc(55%*var(--ink-k)),transparent),var(--color-accent)_var(--tune-mix))] transition-[color,text-shadow] duration-140 [text-shadow:0_0_7px_color-mix(in_srgb,var(--color-accent)_var(--tune-mix),transparent)]"
    >{tuner.note}</span
  >
  {#if strobeMode}
    <span
      class="tuner-strobe flex h-[1.65rem] min-w-0 items-center"
      role="img"
      aria-label={tuner.ready ? `${tuner.cents} cents` : 'No note detected'}
    >
      <StrobeDisplay
        reading={heldReading}
        visible={readingVisible}
        tuneMix={tuner.tuneMix}
        multipliers={strobeRows}
        density={variant === 'stage' ? 'stage' : 'compact'}
      />
    </span>
  {:else}
    <!-- The needle eases in cents (the rAF loop above) and is warped into scale
         position only here, so the smoothing constant keeps one meaning at
         every magnification. -->
    <span
      class="tuner-scale"
      class:close={tuner.close}
      role="img"
      aria-label={tuner.ready ? `${tuner.cents} cents` : 'No note detected'}
      style:--tick-lo={`${needleTicks.lo}%`}
      style:--tick-hi={`${needleTicks.hi}%`}
    >
      <span
        class={[
          'tuner-indicator absolute inset-0 z-1 opacity-100 transition-opacity duration-150 [will-change:transform]',
          !readingVisible && 'opacity-0',
        ]}
        style={`transform:translateX(${needleOffset(displayedCents, needlePrecision)}%)`}
      >
        <span class="tuner-needle"></span>
      </span>
    </span>
  {/if}
  <span
    class={[
      'tuner-cents text-right font-mono text-[length:var(--footer-font-size,.75rem)] leading-normal font-bold tracking-[.08em] text-[color:color-mix(in_srgb,color-mix(in_srgb,var(--color-ink)_calc(75%*var(--ink-k)),transparent),var(--color-accent)_var(--tune-mix))] tabular-nums transition-[color,opacity] duration-150',
      !readingVisible && 'opacity-0',
      variant !== 'stage' && 'max-[620px]:hidden',
    ]}
  >
    {tuner.ready ? `${tuner.cents > 0 ? '+' : ''}${tuner.cents}c` : ''}
  </span>
</span>

<style>
  /* The scale is a custom instrument drawing: its warped ticks, paired centre
     markers, needle geometry and stage-size overrides stay together here. */
  .tuner-scale {
    position: relative;
    height: 0.55rem;
    --scale-line: color-mix(in srgb, var(--color-ink) 25%, transparent);
    --scale-stroke: 1px;
    --tick-lo: 25%;
    --tick-hi: 75%;
    /* Ticks at the centre and the ±25c marks only — none at either edge, so the
       scale stays symmetrical. The ±25c positions come from needle.ts: on
       magnified scales they slide outward with the warp so they keep marking
       real cents. */
    background-image:
      linear-gradient(
        to right,
        transparent calc(var(--tick-lo) - var(--scale-stroke)),
        var(--scale-line) calc(var(--tick-lo) - var(--scale-stroke)) var(--tick-lo),
        transparent var(--tick-lo) calc(50% - var(--scale-stroke)),
        var(--scale-line) calc(50% - var(--scale-stroke)) 50%,
        transparent 50% calc(var(--tick-hi) - var(--scale-stroke)),
        var(--scale-line) calc(var(--tick-hi) - var(--scale-stroke)) var(--tick-hi),
        transparent var(--tick-hi)
      ),
      linear-gradient(
        to bottom,
        transparent calc(50% - var(--scale-stroke) / 2),
        var(--scale-line) calc(50% - var(--scale-stroke) / 2) calc(50% + var(--scale-stroke) / 2),
        transparent calc(50% + var(--scale-stroke) / 2)
      );
  }
  .tuner-scale::before,
  .tuner-scale::after {
    content: '';
    position: absolute;
    left: 50%;
    width: 1px;
    height: 0.28rem;
    transform: translateX(-50%);
    background: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-ink) calc(45% * var(--ink-k)), transparent),
      var(--color-accent) var(--tune-mix)
    );
    transition: background-color 140ms ease;
  }
  .tuner-scale::before {
    bottom: calc(100% + 0.09rem);
  }
  .tuner-scale::after {
    top: calc(100% + 0.09rem);
  }
  .tuner-needle {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0.19rem;
    height: 0.62rem;
    transform: translate(-50%, -50%);
    border-radius: 99px;
    background: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-ink) 62%, transparent),
      var(--color-accent) var(--tune-mix)
    );
    box-shadow: 0 0 9px color-mix(in srgb, var(--color-accent) var(--tune-mix), transparent);
    transition:
      background-color 140ms ease,
      box-shadow 140ms ease;
  }
  .tuner-scale.close .tuner-needle {
    background: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-ink) 82%, transparent),
      var(--color-accent) var(--tune-mix)
    );
  }
  /* Same horizontal instrument as the footer, scaled into a stage-readable
     surface. clamp() keeps it useful at the 640×480 minimum window without
     letting an ultrawide display turn the note and cents into billboards. */
  .stage .note {
    font-size: clamp(2.5rem, 7vw, 5.5rem);
    text-shadow: 0 0 20px color-mix(in srgb, var(--color-accent) var(--tune-mix), transparent);
  }
  .stage .tuner-cents {
    font-size: clamp(1.5rem, 3.5vw, 3rem);
  }
  .stage .tuner-scale {
    height: clamp(5rem, 15vw, 11rem);
    --scale-stroke: 3px;
  }
  .stage .tuner-scale::before,
  .stage .tuner-scale::after {
    width: 4px;
    height: clamp(1.2rem, 3vw, 2.2rem);
  }
  .stage .tuner-scale::before {
    bottom: calc(100% + 0.5rem);
  }
  .stage .tuner-scale::after {
    top: calc(100% + 0.5rem);
  }
  .stage .tuner-needle {
    width: clamp(0.65rem, 1.4vw, 1.1rem);
    height: calc(100% + 1.6rem);
    box-shadow: 0 0 32px color-mix(in srgb, var(--color-accent) var(--tune-mix), transparent);
  }
  .stage .tuner-strobe {
    height: clamp(8rem, 34vh, 18rem);
    border-radius: 0.4rem;
    box-shadow: 0 0 30px
      color-mix(
        in srgb,
        color-mix(in srgb, var(--color-accent) var(--tune-mix), transparent) 35%,
        transparent
      );
  }

  @media (prefers-reduced-motion: reduce) {
    .note,
    .tuner-scale::before,
    .tuner-scale::after,
    .tuner-needle,
    .tuner-cents,
    .tuner-indicator {
      transition: none;
    }
  }
</style>
