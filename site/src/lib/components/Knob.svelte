<script lang="ts">
  /**
   * A decorative knob, drawn to match the app's real one: a recessed face, a
   * track arc sweeping 270° from lower-left to lower-right, a value arc in the
   * module's accent, and a pointer.
   *
   * Static on purpose: it takes a value and renders it. The landing page is a
   * picture of the product, not a copy of it, and a knob you can actually drag
   * invites the reader to think the page is the app.
   */
  interface Props {
    label: string;
    /** 0–1. */
    value: number;
    size?: number;
  }

  let { label, value, size = 46 }: Props = $props();

  const SWEEP = 270;
  const START = 135; // degrees clockwise from 12 o'clock, i.e. lower-left

  const r = $derived(size / 2 - 4);
  const c = $derived(size / 2);

  /** Polar → cartesian, with 0° at 12 o'clock and angles running clockwise. */
  function point(angle: number, radius: number) {
    const rad = ((angle - 180) * Math.PI) / 180;
    return { x: c + radius * Math.sin(rad), y: c - radius * Math.cos(rad) };
  }

  function arc(fromDeg: number, toDeg: number, radius: number) {
    const a = point(fromDeg, radius);
    const b = point(toDeg, radius);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`;
  }

  const clamped = $derived(Math.min(1, Math.max(0, value)));
  const endDeg = $derived(START + SWEEP * clamped);
  const track = $derived(arc(START, START + SWEEP, r));
  const filled = $derived(arc(START, endDeg, r));
  /** The pointer stops short of the face's edge, as the app's does. */
  const pointerFrom = $derived(point(endDeg, r * 0.3));
  const pointerTo = $derived(point(endDeg, r * 0.66));
</script>

<div class="flex flex-col items-center gap-1.5">
  <svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
    <!-- Face: the app's --color-knob, a step darker than the card it sits on. -->
    <circle cx={c} cy={c} r={r * 0.76} fill="var(--color-knob, #0a0c10)" />
    <circle
      cx={c}
      cy={c}
      r={r * 0.76}
      fill="none"
      stroke="color-mix(in srgb, var(--color-ink) 10%, transparent)"
    />
    <path d={track} fill="none" stroke="var(--edge)" stroke-width="2.5" stroke-linecap="round" />
    <path
      d={filled}
      fill="none"
      stroke="var(--knob-accent, var(--color-accent))"
      stroke-width="2.5"
      stroke-linecap="round"
    />
    <line
      x1={pointerFrom.x}
      y1={pointerFrom.y}
      x2={pointerTo.x}
      y2={pointerTo.y}
      stroke="var(--knob-accent, var(--color-accent))"
      stroke-width="2"
      stroke-linecap="round"
    />
  </svg>
  <span
    class="text-control-quiet font-mono text-[0.56rem] font-semibold tracking-[0.1em] uppercase"
  >
    {label}
  </span>
</div>
