<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';
  import { cn } from '../../lib/components/classNames';

  /**
   * One level zone of the status bar (IN or OUT): peak meter, draggable gain
   * marker with its dB tooltip, clip indicator with a 2s hold, and the dB
   * readout. All per-side interaction state lives here — the bar renders the
   * component twice instead of writing the meter twice.
   */
  interface Props {
    side: 'input' | 'output';
    /** Zone caption: "IN" / "OUT". */
    label: string;
    /** Linear peak from the engine (not dB). */
    peak: number;
    gainDb: number;
    onSetGain: (db: number) => void;
    /** Replaces the readout slot entirely (the IN meter's standby badge). */
    badge?: Snippet;
  }

  let { side, label, peak, gainDb, onSetGain, badge }: Props = $props();

  const sideName = $derived(side === 'input' ? 'Input' : 'Output');

  let clip = $state(false);
  let clipTimer: ReturnType<typeof setTimeout> | undefined;
  const clipHoldMs = 2000;
  let tooltipVisible = $state(false);
  let tooltipHideTimer: ReturnType<typeof setTimeout> | undefined;
  let markerHovered = $state(false);
  let pointerActive = false;
  let pointerStartX = 0;
  let pointerMoved = false;
  const minGainDb = -24;
  const maxGainDb = 24;
  const gainStepDb = 0.5;
  const defaultGainDb = 0;
  const dragThresholdPx = 3;

  const db = (value: number) => (value > 0.00001 ? Math.max(-60, 20 * Math.log10(value)) : -60);
  const meterFill = (value: number) =>
    `${Math.max(0, Math.min(100, ((db(value) + 60) / 60) * 100))}%`;
  const gainPosition = (gain: number) => `${((gain + 24) / 48) * 100}%`;
  const peakDb = $derived(db(peak));
  const hot = $derived(peakDb >= -3);
  const clipping = $derived(peakDb >= -0.1);
  const gainText = $derived(`${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`);

  function clearTooltipHideTimer() {
    if (tooltipHideTimer !== undefined) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = undefined;
  }

  function showTooltip() {
    clearTooltipHideTimer();
    tooltipVisible = true;
  }

  function hideTooltipAfterDelay() {
    clearTooltipHideTimer();
    tooltipHideTimer = setTimeout(() => {
      tooltipVisible = false;
      tooltipHideTimer = undefined;
    }, 1000);
  }

  function pointerIsOnMarker(gain: number, event: PointerEvent) {
    const input = event.currentTarget as HTMLInputElement;
    const bounds = input.getBoundingClientRect();
    const markerX = bounds.left + ((gain + 24) / 48) * bounds.width;
    return Math.abs(event.clientX - markerX) <= 10;
  }

  function setGainFromPointer(event: PointerEvent) {
    const input = event.currentTarget as HTMLInputElement;
    const bounds = input.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const normalized = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onSetGain(Math.round((-24 + normalized * 48) * 2) / 2);
  }

  function handlePointerDown(event: PointerEvent) {
    const input = event.currentTarget as HTMLInputElement;
    event.preventDefault();

    pointerActive = pointerIsOnMarker(gainDb, event);
    if (pointerActive) {
      pointerStartX = event.clientX;
      pointerMoved = false;
      input.focus();
      input.setPointerCapture(event.pointerId);
      markerHovered = true;
      showTooltip();
    }
  }

  function handlePointerMove(event: PointerEvent) {
    markerHovered = pointerActive || pointerIsOnMarker(gainDb, event);
    if (pointerActive) {
      if (Math.abs(event.clientX - pointerStartX) >= dragThresholdPx) pointerMoved = true;
      if (pointerMoved) setGainFromPointer(event);
    }
  }

  function handlePointerUp(event: PointerEvent) {
    const input = event.currentTarget as HTMLInputElement;
    const resetToDefault = pointerActive && !pointerMoved;
    pointerActive = false;
    if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    if (resetToDefault) onSetGain(defaultGainDb);
    markerHovered = resetToDefault || pointerIsOnMarker(Number(input.value), event);
    hideTooltipAfterDelay();
  }

  function handlePointerCancel() {
    pointerActive = false;
    markerHovered = false;
    hideTooltipAfterDelay();
  }

  function handlePointerLeave() {
    markerHovered = false;
    if (!pointerActive) hideTooltipAfterDelay();
  }

  function handleDoubleClick(event: MouseEvent) {
    event.preventDefault();
    onSetGain(defaultGainDb);
    markerHovered = true;
    showTooltip();
    hideTooltipAfterDelay();
  }

  function handleInput(value: number) {
    onSetGain(value);
    if (!pointerActive) {
      showTooltip();
      hideTooltipAfterDelay();
    }
  }

  function handleFocus() {
    if (!pointerActive) showTooltip();
  }

  // A non-passive listener is required so adjusting a gain marker consumes the
  // wheel gesture instead of scrolling whatever sits behind the status bar.
  function wheelAdjust(node: HTMLInputElement) {
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();

      const direction = event.deltaY < 0 ? 1 : -1;
      const next = Math.max(minGainDb, Math.min(maxGainDb, gainDb + direction * gainStepDb));
      if (next !== gainDb) onSetGain(next);
      showTooltip();
      hideTooltipAfterDelay();
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }

  function clearClip() {
    clip = false;
    if (clipTimer !== undefined) clearTimeout(clipTimer);
    clipTimer = undefined;
  }

  // Reads peakDb, not the `clipping` edge: every clipping sample re-arms the
  // hold, so the marker stays lit for 2s past the *last* clip, not the first.
  $effect(() => {
    if (peakDb < -0.1) return;
    clip = true;
    if (clipTimer !== undefined) clearTimeout(clipTimer);
    clipTimer = setTimeout(() => {
      clip = false;
      clipTimer = undefined;
    }, clipHoldMs);
  });

  // Deliberately not the effect's teardown: that runs before every re-run, so
  // the first sample below the threshold would cancel the hold and leave `clip`
  // latched on. The timer has to outlive the effect run that armed it.
  onDestroy(() => {
    clearTooltipHideTimer();
    if (clipTimer !== undefined) clearTimeout(clipTimer);
  });
</script>

<section
  class={cn(
    'grid h-full w-[min(100%,18rem)] min-w-0 grid-cols-[auto_minmax(4rem,13rem)_2.5rem] items-center justify-start gap-[.45rem] justify-self-start rounded-[.3rem] px-[.7rem] max-[620px]:w-full max-[620px]:grid-cols-[auto_minmax(2.5rem,1fr)] max-[620px]:gap-[.35rem] max-[620px]:px-[.55rem]',
    side === 'output' && 'relative justify-self-end',
  )}
  aria-label="{sideName} level"
>
  <span
    class="font-mono text-[length:var(--footer-font-size)] font-bold tracking-[.08em] text-[color:color-mix(in_srgb,var(--color-ink)_calc(55%_*_var(--ink-k)),transparent)]"
    >{label}</span
  >
  <div
    class="relative h-[.4rem] rounded-full bg-ink/10"
    style={`--fill:${meterFill(peak)}; --gain:${gainPosition(gainDb)}`}
  >
    <span
      class={cn(
        'absolute inset-y-0 left-0 w-(--fill) rounded-[inherit] bg-ink/58 [transition:width_70ms_linear,background-color_90ms_ease]',
        hot && 'bg-hot shadow-[0_0_5px_color-mix(in_srgb,var(--color-hot)_35%,transparent)]',
        clipping &&
          'bg-danger shadow-[0_0_6px_color-mix(in_srgb,var(--color-danger)_55%,transparent)]',
      )}
    ></span><span
      class={cn(
        'pointer-events-none absolute top-1/2 left-(--gain) z-[1] h-[.85rem] w-[.14rem] -translate-1/2 rounded-full bg-ink shadow-[0_0_5px_color-mix(in_srgb,var(--color-ink)_45%,transparent)]',
        clipping && 'bg-[#fff0f2]',
      )}
      aria-hidden="true"
    ></span>
    <span
      id="{side}-gain-tooltip"
      class={cn(
        'pointer-events-none absolute bottom-[calc(100%+.4rem)] left-(--gain) z-4 -translate-x-1/2 translate-y-[.15rem] rounded-control-xs border border-ink/14 bg-menu px-[.38rem] py-[.24rem] font-mono text-(length:--footer-font-size) font-bold whitespace-nowrap text-ink opacity-0 [transition:opacity_100ms_ease,translate_100ms_ease]',
        tooltipVisible && 'translate-y-0 opacity-100',
      )}
      role="tooltip">{gainText}</span
    >
    <input
      class={cn(
        'absolute inset-x-0 inset-y-[-0.6rem] z-2 m-0 w-full cursor-default opacity-0',
        markerHovered && 'cursor-ew-resize',
      )}
      aria-label="{sideName} gain"
      aria-describedby="{side}-gain-tooltip"
      aria-valuetext={gainText}
      type="range"
      min={minGainDb}
      max={maxGainDb}
      step={gainStepDb}
      value={gainDb}
      {@attach wheelAdjust}
      onfocus={handleFocus}
      onblur={hideTooltipAfterDelay}
      onpointerenter={showTooltip}
      onpointerleave={handlePointerLeave}
      onpointermove={handlePointerMove}
      onpointerdown={handlePointerDown}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerCancel}
      ondblclick={handleDoubleClick}
      oninput={(e) => handleInput(Number(e.currentTarget.value))}
    />
  </div>
  {#if badge}{@render badge()}{:else if clip}<button
      class="w-10 cursor-pointer rounded-[.2rem] border-0 bg-danger py-[.2rem] font-mono text-[length:var(--footer-font-size)] font-bold tracking-[.03em] text-lit shadow-[0_0_7px_color-mix(in_srgb,var(--color-danger)_45%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_80%,var(--color-ink))]"
      onclick={clearClip}
      aria-label="Clear {sideName.toLowerCase()} clip indicator">CLIP</button
    >{:else}<output
      class="text-right font-mono text-[length:var(--footer-font-size)] font-bold tracking-[.08em] text-[color:color-mix(in_srgb,var(--color-ink)_calc(75%_*_var(--ink-k)),transparent)] max-[620px]:hidden"
      >{peakDb.toFixed(0)}</output
    >{/if}
</section>
