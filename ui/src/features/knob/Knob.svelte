<script lang="ts">
  import ControlLabel from './ControlLabel.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';

  interface Props {
    label: string;
    value: number; // normalised 0..1
    defaultValue: number; // normalised 0..1
    text?: string;
    valueStrings?: string[];
    onChange: (v: number) => void;
    /** When provided, the label becomes click-to-edit. */
    onRename?: (label: string) => void;
  }

  let { label, value, defaultValue, text, valueStrings, onChange, onRename }: Props = $props();

  // Drag travel for the full 0..1 sweep. A continuous knob wants the whole
  // budget for fine control, but spending it on a handful of detents makes each
  // step a haul (75px to flip a 2-state knob) — so a discrete knob pays per
  // detent instead, up to the continuous budget.
  const SWEEP_PX = 150;
  const PX_PER_DETENT = 30;
  // Hold Shift to stretch the sweep for fine adjustment. Shift because Ctrl/Cmd
  // is already page zoom (App.svelte) and Shift is the convention plugin UIs use.
  const FINE_RATE = 0.25;

  let dragging = $state(false);
  let shiftHeld = $state(false);
  let lastY = 0;
  let dragVal = 0;

  const detentCount = $derived(valueStrings?.length ?? 0);
  const isDiscrete = $derived(detentCount > 1);
  /** Drives the visual only; the drag reads the live event so the value it
      applies never depends on reactivity timing. */
  const fine = $derived(shiftHeld && !isDiscrete);
  const sweepPx = $derived(
    isDiscrete ? Math.min(SWEEP_PX, PX_PER_DETENT * (detentCount - 1)) : SWEEP_PX,
  );
  const logicalSteps = $derived(
    isDiscrete ? Array.from({ length: detentCount }, (_, index) => index / (detentCount - 1)) : [],
  );
  const displayValue = $derived(isDiscrete ? logicalSteps[activeDetent()] : value);
  const angle = $derived(-135 + displayValue * 270);

  function snap(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    if (!isDiscrete) return clamped;
    return logicalSteps.reduce((nearest, candidate) =>
      Math.abs(candidate - clamped) < Math.abs(nearest - clamped) ? candidate : nearest,
    );
  }

  function activeDetent() {
    if (!logicalSteps.length) return 0;
    return logicalSteps.reduce(
      (nearest, candidate, index) =>
        Math.abs(candidate - value) < Math.abs(logicalSteps[nearest] - value) ? index : nearest,
      0,
    );
  }

  // Shift can be taken or released without the pointer moving, so the cue can't
  // come from the drag alone. A pointer capture redirects pointer events only —
  // key events still reach the focused element, and pressing a knob focuses it,
  // so the button's own key handlers see the modifier mid-drag. Reading the flag
  // off the event means a Shift keyup reports false without special-casing it.
  function syncModifier(e: KeyboardEvent | PointerEvent) {
    shiftHeld = e.shiftKey;
  }

  function down(e: PointerEvent) {
    dragging = true;
    // Shift held from before the gesture fires no keydown of its own.
    syncModifier(e);
    lastY = e.clientY;
    // Discrete drags measure from the detent, not the plugin's raw value, so a
    // value sitting slightly off a step can't bias every step of the gesture.
    dragVal = displayValue;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  // Travel accumulates per move rather than from the press point, so Shift can
  // be taken or released mid-gesture and only changes the rate from there on;
  // rescaling the whole delta would jump the value the instant it was pressed.
  function move(e: PointerEvent) {
    if (!dragging) return;
    // Fine adjust is meaningless with detents — there is nothing in between to
    // reach for, and slowing the drag would only put the steps back out of reach.
    const isFine = e.shiftKey && !isDiscrete;
    syncModifier(e); // heals the cue if a key event was missed
    dragVal += ((lastY - e.clientY) / sweepPx) * (isFine ? FINE_RATE : 1); // up = increase
    lastY = e.clientY;
    onChange(snap(dragVal));
  }

  function up(e: PointerEvent) {
    dragging = false;
    // The knob keeps focus after the release, so Shift still means fine steps
    // for the arrow keys — the cue should outlast the drag, not the modifier.
    syncModifier(e);
  }

  function reset(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange(snap(defaultValue));
  }

  function keydown(e: KeyboardEvent) {
    syncModifier(e); // before the early return: Shift alone is not an arrow key
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(e.key)) return;
    e.preventDefault();
    const direction = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1;
    if (isDiscrete) {
      const next = Math.max(0, Math.min(detentCount - 1, activeDetent() + direction));
      onChange(logicalSteps[next]);
    } else {
      // Shift is the same fine modifier as the drag, so the two agree.
      onChange(snap(value + direction * 0.01 * (e.shiftKey ? FINE_RATE : 1)));
    }
  }
</script>

<div class="flex w-16 flex-col items-center gap-2 text-center select-none">
  <button
    type="button"
    class="knob-container relative grid size-11 cursor-ns-resize place-items-center transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] hover:scale-[1.08] focus:outline-none focus-visible:scale-[1.08] focus-visible:outline-none"
    class:dragging
    class:fine
    onkeyup={syncModifier}
    onblur={() => (shiftHeld = false)}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onlostpointercapture={up}
    ondblclick={reset}
    onkeydown={keydown}
    aria-label={label}
    role="slider"
    aria-valuemin="0"
    aria-valuemax={isDiscrete ? detentCount - 1 : 1}
    aria-valuenow={isDiscrete ? activeDetent() : value}
    aria-valuetext={text}
  >
    <!-- Readout shows only the plugin's own formatted text (streamed via
         paramValues); no tooltip until the first value arrives. -->
    {#if text}
      <span class="knob-tooltip" role="tooltip">{text}</span>
    {/if}
    <span class="knob-ring" class:discrete={isDiscrete}>
      {#if isDiscrete}
        {#each logicalSteps as stepValue, index (index)}
          <span
            class="detent"
            class:active={index === activeDetent()}
            style="--detent-angle: {-135 + stepValue * 270}deg"
            {@attach tooltip(valueStrings?.[index])}
          ></span>
        {/each}
      {/if}
    </span>
    <span class="knob">
      <span class="knob-indicator" style="transform: rotate({angle}deg);"></span>
    </span>
  </button>
  <ControlLabel {label} {onRename} />
</div>

<style>
  /* The knob face, detents, rotating indicator and tooltip arrow form one
     custom-drawn control. Keeping their coupled geometry here is clearer than
     distributing it across deeply nested arbitrary utility variants. */
  .knob {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: var(--color-knob);
    border: 1px solid color-mix(in srgb, var(--color-ink) 20%, transparent);
    box-shadow:
      inset 0 4px 10px color-mix(in srgb, var(--color-void) 80%, transparent),
      0 5px 15px color-mix(in srgb, var(--color-void) 70%, transparent);
    position: relative;
    transition:
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }
  .knob-container:hover .knob,
  .knob-container:focus-visible .knob {
    border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
    box-shadow:
      inset 0 4px 10px color-mix(in srgb, var(--color-void) 80%, transparent),
      0 5px 20px color-mix(in srgb, var(--color-accent) 25%, transparent);
  }

  .knob-indicator {
    display: block;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 2;
  }
  .knob-indicator::after {
    content: '';
    position: absolute;
    top: 5px;
    left: 50%;
    transform: translateX(-50%);
    width: 3px;
    height: 9px;
    background-color: var(--color-accent);
    border-radius: 2px;
    box-shadow: var(--shadow-glow-accent);
    transition:
      width 150ms ease,
      height 150ms ease,
      top 150ms ease;
  }

  .knob-ring {
    display: block;
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1px dashed color-mix(in srgb, var(--color-ink) 20%, transparent);
    pointer-events: none;
    transition:
      border-color 0.3s ease,
      transform 0.3s ease,
      inset 150ms ease;
  }
  .knob-ring.discrete {
    border-color: transparent;
  }
  .detent {
    position: absolute;
    inset: -1px;
    transform: rotate(var(--detent-angle));
    pointer-events: none;
  }
  .detent::after {
    content: '';
    position: absolute;
    top: -1px;
    left: 50%;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--color-ink) 38%, transparent);
    transform: translateX(-50%);
    transition:
      background-color 120ms ease,
      box-shadow 120ms ease,
      transform 120ms ease;
  }
  .detent.active::after {
    background: var(--color-accent);
    box-shadow: var(--shadow-glow-accent);
    transform: translateX(-50%) scale(1.6);
  }
  .knob-container:hover .knob-ring:not(.discrete),
  .knob-container:focus-visible .knob-ring:not(.discrete) {
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    transform: rotate(5deg);
  }
  .knob-container:hover .detent::after,
  .knob-container:focus-visible .detent::after {
    background: color-mix(in srgb, var(--color-accent) 55%, var(--color-ink));
  }

  /* Fine adjust reads as the control getting sharper: the pointer narrows to a
     hairline and the loose dashed ring resolves into one solid line, pulled out
     clear of the face. Geometry rather than a badge, so the cue never competes
     with the value readout sitting directly above. Only continuous knobs can
     enter this state (see `fine`), but the hover rule above is selector-for-
     selector as specific, so this one matches its weight to win on order. */
  .knob-container.fine .knob-indicator::after {
    width: 1px;
    height: 13px;
    top: 3px;
    border-radius: 1px;
  }
  .knob-container.fine .knob-ring:not(.discrete) {
    inset: -7px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
  }

  .knob-tooltip {
    position: absolute;
    bottom: calc(100% + 14px);
    left: 50%;
    transform: translate(-50%, 4px);
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
    background: color-mix(in srgb, var(--color-void) 90%, transparent);
    color: var(--color-accent);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    z-index: 10;
    box-shadow: var(--shadow-glow-accent);
    transition:
      opacity 0.2s ease,
      transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .knob-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 4px solid transparent;
    border-top-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
  }
  /* Pinned for the whole drag: pointer capture keeps the gesture alive after
     the pointer leaves the knob, where :hover alone would hide the readout.
     Keyboard focus shows it too — the arrow keys move the value, so the reading
     has to be visible without a pointer. */
  .knob-container:hover .knob-tooltip,
  .knob-container:focus-visible .knob-tooltip,
  .knob-container.dragging .knob-tooltip {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  /* --color-void carries its own alpha in light, so the dark theme's near-opaque
     backing lands there as a mid-grey wash with the dark-teal accent text
     unreadable on it. Light uses the same surface as every other popover. */
  :global(:root[data-theme='light']) .knob-tooltip {
    background: var(--color-menu);
  }

  /* The dark knob is lit from above as a *dished* face — a heavy top inset over
     near-black. On a light page that same geometry reads as a hole punched in
     the card. Light inverts it into a raised cap: a lit top edge, shading
     gathered underneath, and a short contact shadow beneath the knob. */
  :global(:root[data-theme='light']) .knob {
    box-shadow:
      inset 0 1px 0 var(--color-lit),
      inset 0 -3px 7px color-mix(in srgb, var(--color-void) 30%, transparent),
      0 2px 4px color-mix(in srgb, var(--color-void) 28%, transparent);
  }
  :global(:root[data-theme='light']) .knob-container:hover .knob,
  :global(:root[data-theme='light']) .knob-container:focus-visible .knob {
    box-shadow:
      inset 0 1px 0 var(--color-lit),
      inset 0 -3px 7px color-mix(in srgb, var(--color-void) 30%, transparent),
      0 2px 9px color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
</style>
