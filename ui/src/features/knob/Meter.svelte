<script lang="ts">
  import ControlLabel from './ControlLabel.svelte';

  interface Props {
    label: string;
    value: number; // normalised 0..1, streamed live from the engine
    text?: string;
    /** Fill from the centre outward (0.5 = zero) instead of from the left edge —
        for signed readouts like a tuner's ±cents. */
    bipolar?: boolean;
    /** When provided, the label becomes click-to-edit. */
    onRename?: (label: string) => void;
  }

  let { label, value, text, bipolar = false, onRename }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(1, value)));
  // Readout shows only the plugin's own formatted text (e.g. a tuner's
  // "A4 +3¢"); blank until the engine streams one.
  const readout = $derived(text ?? '');

  // Fill geometry as {left, width} percentages. Unipolar grows from the left
  // edge; bipolar anchors at the centre and grows left (value < 0.5) or right.
  const bar = $derived.by(() => {
    if (!bipolar) return { left: 0, width: clamped * 100 };
    const from = Math.min(clamped, 0.5);
    return { left: from * 100, width: Math.abs(clamped - 0.5) * 100 };
  });
</script>

<!-- A meter is display-only: it never calls back to the engine. It renders the
     live value/text the engine streams (see paramValues). -->
<div class="flex w-16 flex-col items-center gap-2 text-center select-none">
  <div
    class="flex size-11 flex-col items-center justify-center gap-1.5 rounded-[7px] border border-[color-mix(in_srgb,var(--color-ink)_20%,transparent)] bg-well px-1 shadow-[inset_0_2px_8px_color-mix(in_srgb,var(--color-void)_80%,transparent)] [html[data-theme='light']_&]:shadow-[inset_0_1px_0_var(--color-lit),inset_0_-2px_5px_color-mix(in_srgb,var(--color-void)_22%,transparent),0_1px_3px_color-mix(in_srgb,var(--color-void)_22%,transparent)]"
    aria-label={label}
    role="meter"
    aria-valuenow={value}
    aria-valuemin="0"
    aria-valuemax="1"
  >
    <span
      class="max-w-full overflow-hidden text-[10px] leading-none font-bold tracking-[.02em] text-ellipsis whitespace-nowrap text-accent [text-shadow:var(--shadow-glow-accent)]"
      >{readout}</span
    >
    <span
      class={[
        'relative block h-1 w-full overflow-hidden rounded-xs bg-[color-mix(in_srgb,var(--color-ink)_12%,transparent)]',
        bipolar &&
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-[color-mix(in_srgb,var(--color-ink)_35%,transparent)] after:content-['']",
      ]}
    >
      <span
        class="absolute inset-y-0 bg-accent shadow-(--shadow-glow-accent) transition-[left,width] duration-80 ease-linear"
        style="left: {bar.left}%; width: {bar.width}%"
      ></span>
    </span>
  </div>
  <ControlLabel {label} {onRename} />
</div>
