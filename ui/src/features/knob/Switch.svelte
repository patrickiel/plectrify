<script lang="ts">
  import ControlLabel from './ControlLabel.svelte';
  import { cn } from '../../lib/components/classNames';

  interface Props {
    label: string;
    value: number; // normalised 0..1; on when >= 0.5
    text?: string;
    onChange: (v: number) => void;
    /** When provided, the label becomes click-to-edit. */
    onRename?: (label: string) => void;
  }

  let { label, value, text, onChange, onRename }: Props = $props();

  const on = $derived(value >= 0.5);

  let toggleText = $state<HTMLElement>();
  let twoLines = $state(false);

  // CSS cannot transition between an intrinsic one-line height and a wrapped
  // two-line height. Measure the rendered text and switch between explicit
  // heights so both expansion and contraction animate.
  function updateTextHeight() {
    if (!toggleText) return;
    const lineHeight = Number.parseFloat(getComputedStyle(toggleText).lineHeight);
    twoLines = toggleText.scrollHeight > lineHeight + 1;
  }

  $effect(() => {
    text;
    on;
    // A frame late, so the new text has been laid out before it is measured;
    // cancelled on teardown so a re-run or an unmount cannot measure a stale
    // (or detached) element.
    const frame = requestAnimationFrame(updateTextHeight);
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="flex w-16 flex-col items-center gap-2 text-center select-none">
  <div class="flex size-11 items-center justify-center">
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onclick={() => onChange(on ? 0 : 1)}
      class={cn(
        'm-0 flex h-6 max-h-[calc(2*1.15em+8px)] min-h-6 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-[7px] border px-1 py-[3px] text-[10px] leading-normal font-bold tracking-[.05em] transition-all duration-200 ease-[cubic-bezier(.25,.8,.25,1)] focus:outline-none focus-visible:outline-none',
        twoLines && 'h-[calc(2*1.15em+8px)]',
        on
          ? 'border-accent bg-accent text-accent-ink shadow-(--shadow-glow-accent) hover:text-accent-ink focus-visible:text-accent-ink [html[data-theme=light]_&]:shadow-(--shadow-glow-accent)'
          : 'border-[color-mix(in_srgb,var(--color-ink)_30%,transparent)] bg-well text-muted shadow-[inset_0_2px_5px_color-mix(in_srgb,var(--color-void)_80%,transparent)] hover:border-accent hover:text-accent hover:shadow-[inset_0_2px_5px_color-mix(in_srgb,var(--color-void)_80%,transparent),0_0_12px_color-mix(in_srgb,var(--color-accent)_20%,transparent)] focus-visible:border-accent focus-visible:text-accent focus-visible:shadow-[inset_0_2px_5px_color-mix(in_srgb,var(--color-void)_80%,transparent),0_0_12px_color-mix(in_srgb,var(--color-accent)_20%,transparent)] [html[data-theme=light]_&]:shadow-[inset_0_1px_0_var(--color-lit),inset_0_-2px_4px_color-mix(in_srgb,var(--color-void)_22%,transparent),0_1px_3px_color-mix(in_srgb,var(--color-void)_22%,transparent)] [html[data-theme=light]_&]:hover:shadow-[inset_0_1px_0_var(--color-lit),inset_0_-2px_4px_color-mix(in_srgb,var(--color-void)_22%,transparent),0_1px_6px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] [html[data-theme=light]_&]:focus-visible:shadow-[inset_0_1px_0_var(--color-lit),inset_0_-2px_4px_color-mix(in_srgb,var(--color-void)_22%,transparent),0_1px_6px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]',
      )}
    >
      <span
        bind:this={toggleText}
        class="line-clamp-2 max-w-full overflow-hidden leading-[1.15] [overflow-wrap:anywhere]"
        >{text ?? (on ? 'ON' : 'OFF')}</span
      >
    </button>
  </div>
  <ControlLabel {label} {onRename} />
</div>
