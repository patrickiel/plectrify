<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { TunerReading } from '../../lib/engine/types';
  import {
    advanceStrobe,
    beatHz,
    CENTS_TIME_CONSTANT_SECONDS,
    clampTurnsPerSecond,
    easeToward,
    MAX_FRAME_SECONDS,
    referenceHz,
    smearAmount,
    STROBE_MULTIPLIERS,
    strobeBands,
    type StrobeBand,
    type StrobePhase,
  } from './strobe';

  type DetectedReading = Extract<TunerReading, { detected: true }>;

  interface Props {
    /** The held reading, or undefined when nothing is being detected. */
    reading: DetectedReading | undefined;
    /** Whether the reading is currently shown; drives the fade, not the maths. */
    visible: boolean;
    /** 0–100 accent blend, shared with the needle so both readouts agree on
        what "in tune" looks like. */
    tuneMix: number;
    multipliers?: readonly number[];
    /** Larger stripe pitch for the stage overlay; drift maths is unchanged. */
    density?: 'compact' | 'stage';
  }

  let {
    reading,
    visible,
    tuneMix,
    multipliers = STROBE_MULTIPLIERS,
    density = 'compact',
  }: Props = $props();

  /** Target stripes across a lane, and the pixel period that count is allowed to
      produce. Deriving the period from the measured width (rather than fixing it
      in CSS) keeps the stripe count roughly constant at every window size, so the
      pattern stays readable as the bar narrows instead of crowding. */
  const idealPeriodCount = 10;
  const minPeriodPx = $derived(density === 'stage' ? 44 : 18);
  const maxPeriodPx = $derived(density === 'stage' ? 110 : 30);

  /** How long everything must sit still before the animation loop stands down.
      An always-on 60 fps loop in a status bar costs battery at a gig. */
  const idleStopSeconds = 1;
  /** How often the slow half of the display is recomputed. Which lane is
      promoted and how smeared it looks do not need to change per frame. */
  const classifyIntervalSeconds = 0.1;

  let rootEl: HTMLElement | undefined = $state();
  let stripEls: HTMLElement[] = $state([]);

  /** Mirrors of the filtered reading, sampled at the classify rate. These are
      $state because the lane list is derived from them; the per-frame values
      they are sampled from are deliberately not. */
  let classifiedCents = $state(0);
  let classifiedReference = $state(440);

  // Plain locals, not $state: the animation loop reads and writes these every
  // frame, and routing a 60 fps value through Svelte's reactivity would re-run
  // deriveds and template updates for something only the compositor needs.
  let targetCents = 0;
  let reference = 440;
  let hasReading = false;
  let smoothedCents = 0;
  let periodPx = 24;
  let frame: number | undefined;
  let previousTime: number | undefined;
  let classifyCountdown = 0;
  let idleSeconds = 0;

  /** Drift state per lane, keyed by multiplier rather than indexed so a lane keeps
      its phase when the list around it changes.

      A plain Map, deliberately not a SvelteMap: it is written every frame, and
      making those writes reactive is exactly what this component is built to
      avoid. Nothing renders from it — the phase reaches the DOM as a transform. */
  const phases = new Map<number, StrobePhase>();

  function phaseFor(key: number): StrobePhase {
    const existing = phases.get(key);
    if (existing !== undefined) return existing;
    const created: StrobePhase = { phase: 0, rate: 0 };
    phases.set(key, created);
    return created;
  }

  const lanes = $derived(strobeBands(classifiedCents, classifiedReference, multipliers));

  /** Rate a lane should drift at, or 0 when it would only be showing the
      filter's residual noise. */
  function laneRate(band: StrobeBand, cents: number): number {
    if (!band.usable) return 0;
    return clampTurnsPerSecond(band.multiplier * beatHz(cents, reference));
  }

  /** All lanes share a width, so the first track speaks for them all. Queried
      rather than bound: an effect that reads `boundEls[0]` while the array is
      still empty never picks up the dependency, so it would bail once at mount
      and leave the period stuck at its CSS default. */
  function measurePeriod() {
    const root = rootEl;
    const track = root?.querySelector('.lane-track');
    if (root === undefined || track === null || track === undefined) return;
    const width = track.getBoundingClientRect().width;
    if (width <= 0) return;
    periodPx = Math.max(minPeriodPx, Math.min(maxPeriodPx, width / idealPeriodCount));
    root.style.setProperty('--strobe-period', `${periodPx}px`);
  }

  function tick(time: number) {
    frame = requestAnimationFrame(tick);
    const deltaSeconds =
      previousTime === undefined
        ? 0
        : Math.max(0, Math.min(MAX_FRAME_SECONDS, (time - previousTime) / 1000));
    previousTime = time;

    // Filtering the cents rather than the beat frequency keeps the quantity
    // note-relative, so a note change moves the reference without kicking the
    // filter. Far longer than the needle's 85 ms — see strobe.ts. With no
    // reading the target is zero, so a dropout glides the pattern to a stop
    // instead of leaving it drifting on a value nothing is confirming.
    smoothedCents = easeToward(
      smoothedCents,
      hasReading ? targetCents : 0,
      deltaSeconds,
      CENTS_TIME_CONSTANT_SECONDS,
    );

    const classifying = classifyCountdown <= 0;
    let moving = false;

    for (const [index, band] of lanes.entries()) {
      const next = advanceStrobe(
        phaseFor(band.multiplier),
        laneRate(band, smoothedCents),
        deltaSeconds,
      );
      phases.set(band.multiplier, next);
      if (next.rate !== 0) moving = true;

      const strip = stripEls[index];
      if (strip === undefined) continue;
      // The one per-frame DOM write: a composited transform. No layout, no paint.
      strip.style.transform = `translate3d(${next.phase * periodPx}px, 0, 0)`;
      // Each lane smears at its own rate — ×16 is twice as fast as ×8 and loses
      // its edges twice as soon.
      if (classifying) strip.style.setProperty('--strobe-smear', `${smearAmount(next.rate)}`);
    }

    if (classifying) {
      classifyCountdown = classifyIntervalSeconds;
      // Re-pick which lane is worth looking at. Sampling the filtered reading at
      // 10 Hz keeps the lane list, and everything derived from it, off the
      // animation path.
      classifiedCents = smoothedCents;
      classifiedReference = reference;
    } else {
      classifyCountdown -= deltaSeconds;
    }

    idleSeconds = moving || hasReading ? 0 : idleSeconds + deltaSeconds;
    if (idleSeconds >= idleStopSeconds) stop();
  }

  function start() {
    if (frame !== undefined) return;
    previousTime = undefined;
    idleSeconds = 0;
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  $effect(() => {
    const current = reading;
    hasReading = current !== undefined && visible;
    if (current !== undefined) {
      targetCents = current.cents;
      reference = referenceHz(current.midiNote);
    }
    // A fresh reading is the one thing that has to be able to wake a suspended
    // loop, since nothing else is running to notice it.
    if (hasReading) start();
  });

  /** Attached to the root span below. ResizeObserver reports the current size
      on observe, so this covers both the first measurement and every later
      window change. `bind:this` stays for the rest of the component, which
      reads the element outside any effect. */
  function watchWidth(root: Element) {
    const observer = new ResizeObserver(measurePeriod);
    observer.observe(root);
    return () => observer.disconnect();
  }

  onDestroy(stop);
</script>

<!-- One flush stack of lanes, coarsest on top. Each lane is a clipping track
     holding an over-wide strip; the strip overhangs by a full period on both
     sides, so wrapping the phase into [0, period) is seamless in either direction
     and needs no second copy.

     Spans rather than divs throughout: this is rendered inside the status bar's
     tuner <button>, whose content model only allows phrasing content. Every box
     sets its own display, so the tag choice costs nothing.

     The strip is moved with `transform`, never `background-position`. That is
     load-bearing, not stylistic: background-position is not compositor-animated
     in Chromium, so it repaints the element every frame — and the status bar
     carries `backdrop-filter: blur(16px)`, which would then re-run a 16px blur
     across the whole bar at 60 fps. A transform on a promoted layer costs no
     layout and no paint, and interpolates at sub-pixel precision.

     style: directive rather than a whole style attribute, because the loop writes
     --strobe-period to this same element; rewriting the attribute on every
     tuneMix change would silently clobber it. -->
<span
  class="strobe flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xs [--strobe-period:24px]"
  bind:this={rootEl}
  {@attach watchWidth}
  style:--tune-mix={`${tuneMix}%`}
>
  {#each lanes as band, index (band.multiplier)}
    <!-- A lane that could only be showing residual noise is dimmed right down
         rather than drifting convincingly at nothing. -->
    <span
      class={[
        'lane flex min-h-0 min-w-0 flex-1 items-stretch transition-opacity duration-160 motion-reduce:transition-none',
        !visible
          ? 'opacity-100'
          : band.primary
            ? 'opacity-100'
            : band.usable
              ? 'opacity-62'
              : 'opacity-30',
      ]}
    >
      <span class="lane-track relative min-w-0 flex-1 overflow-hidden">
        <span
          class={[
            'lane-strip opacity-100 transition-opacity duration-150 motion-reduce:transition-none',
            !visible && 'opacity-12',
            !band.usable && '[will-change:auto]',
          ]}
          bind:this={stripEls[index]}
        ></span>
      </span>
    </span>
  {/each}
</span>

<style>
  /* --strobe-period is the stripe pitch in px, written by the resize observer;
     it is also exactly how far the strip is translated per turn. Because the
     stripes are upright, the gradient's period and the horizontal period are the
     same number — so the wrap is seamless by construction.

     Bars borrow the needle dot's colour expression, so both readouts light up
     with the same accent at the same cent. */
  .strobe {
    --strobe-bar: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-ink) 68%, transparent),
      var(--color-accent) var(--tune-mix)
    );
  }

  /* A hairline keeps the rows separable without opening a gap. Drawn as an inset
     shadow, not a border: a border would sit inside the flexed box and make the
     row carrying it a pixel taller than its neighbour. */
  .lane + .lane .lane-track {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-void) 55%, transparent);
  }

  /* One bar per period, slightly narrower than its gap so bar and gap never read
     as interchangeable. --strobe-edge softens both stops as the lane speeds up,
     standing in for a real strobe's optical blur; capped well inside the gap so
     the stops can never cross and invert the pattern. */
  .lane-strip {
    --strobe-smear: 0;
    --strobe-edge: calc(var(--strobe-period) * 0.09 * var(--strobe-smear));
    position: absolute;
    inset: 0 calc(-1 * var(--strobe-period));
    will-change: transform;
    background-image: repeating-linear-gradient(
      to right,
      var(--strobe-bar) 0,
      var(--strobe-bar) calc(var(--strobe-period) * 0.44 - var(--strobe-edge)),
      transparent calc(var(--strobe-period) * 0.44 + var(--strobe-edge)),
      transparent var(--strobe-period)
    );
  }
  /* The track is transparent, so the bars sit on whatever surface hosts the
     display; on light that surface is far closer to the bar colour, so the bars
     are pushed harder toward ink to hold their contrast. */
  :global(:root[data-theme='light']) .strobe {
    --strobe-bar: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-ink) 78%, transparent),
      var(--color-accent) var(--tune-mix)
    );
  }
  :global(:root[data-theme='light']) .lane + .lane .lane-track {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-ink) 18%, transparent);
  }
</style>
