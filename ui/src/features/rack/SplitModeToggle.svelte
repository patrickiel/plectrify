<script module lang="ts">
  /** Mix sums every lane; switch makes exactly one lane audible. */
  export type SplitMode = 'mix' | 'switch';
</script>

<script lang="ts">
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';

  interface Props {
    mode: SplitMode;
    /** The engine is still moving to this mode; show a spinner meanwhile. */
    pending?: SplitMode | null;
    onSelect: (mode: SplitMode) => void;
  }

  let { mode, pending = null, onSelect }: Props = $props();

  // Both modes stay legible at all times, so the active one is told apart by
  // fill rather than by hue — red here would read as a warning, not a mode.
  // Switch leads: it is what a fresh split starts in, so the default mode sits
  // first rather than being the segment you have to move to.
  const modes: { id: SplitMode; label: string; hint: string }[] = [
    { id: 'switch', label: 'SWITCH', hint: 'Switch — one lane at a time' },
    { id: 'mix', label: 'MIX', hint: 'Mix — all lanes play together' },
  ];
</script>

<div
  class="[--segmented-background:var(--color-menu)] [--segmented-shadow:0_0_10px_color-mix(in_srgb,var(--color-void)_70%,transparent)]"
>
  <SegmentedControl
    label="Split lane mode"
    value={mode}
    options={modes.map((option) => ({
      value: option.id,
      label: option.label,
      ariaLabel: option.hint,
      tip: option.hint,
      tone: 'accent' as const,
      busy: pending === option.id,
      class: 'min-w-12 whitespace-nowrap font-mono text-[0.6rem] font-bold tracking-[1px]',
    }))}
    {onSelect}
  />
</div>
