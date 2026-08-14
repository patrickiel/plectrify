<script lang="ts" generics="T extends string | number | boolean">
  import { CircleNotchIcon } from 'phosphor-svelte';
  import type { ClassValue } from 'svelte/elements';
  import { tooltip, type TooltipPlacement } from './tooltip.svelte';
  import { cn } from './classNames';

  /** One mutually exclusive choice rendered by {@link SegmentedControl}. */
  interface Option<T> {
    value: T;
    label: string;
    /** Optional count shown as the control's standard inset badge. */
    badge?: string | number;
    /** Spoken label when the visible text is not sufficiently descriptive. */
    ariaLabel?: string;
    tip?: string;
    disabled?: boolean;
    busy?: boolean;
    class?: ClassValue;
    /** Accent is reserved for a choice that enables an editing/action state. */
    tone?: 'neutral' | 'accent';
  }

  interface Props {
    options: readonly Option<T>[];
    value: T;
    onSelect: (value: T) => void;
    /** Accessible name for the whole mutually exclusive choice. */
    label: string;
    /** Menu/sidebar sizing instead of the full toolbar height. */
    compact?: boolean;
    /** Give every option an equal share of the available width. */
    fill?: boolean;
    tipPlacement?: TooltipPlacement;
    class?: ClassValue;
    /** Bindable measured width for layouts that budget neighbouring controls. */
    width?: number;
  }

  let {
    options,
    value,
    onSelect,
    label,
    compact = true,
    fill = false,
    tipPlacement = 'top',
    class: className,
    width = $bindable(0),
  }: Props = $props();

  // One skin, everywhere: the toolbar's Perform/Edit toggle is the reference,
  // and every segmented choice in the app — tool panels included — matches it.
  // `--segmented-background` / `--segmented-shadow` stay as call-site hooks for
  // a group that floats over the rack rather than sitting on chrome.
  const groupBaseClass =
    'inline-flex h-9 items-center rounded-control-md border border-[color:var(--chrome-control-border)] bg-[color:var(--segmented-background,var(--chrome-control-bg))] p-0.5 shadow-[var(--segmented-shadow,var(--chrome-control-shadow))]';
  const segmentBaseClass =
    'relative inline-flex h-full cursor-pointer items-center justify-center gap-1 rounded-control-sm border-0 bg-transparent px-[.85rem] text-[.8rem] font-semibold text-[color:var(--chrome-control-text)] [transition:background-color_140ms_ease,box-shadow_140ms_ease,color_140ms_ease] hover:bg-[var(--chrome-control-hover-bg)] hover:text-ink aria-pressed:bg-[var(--chrome-control-selected-bg)] aria-pressed:text-ink aria-pressed:shadow-[inset_0_0_0_1px_var(--chrome-control-selected-border)] focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)]';
  /** Accent marks the choice that enables an editing/action state — Edit in the
      toolbar. It keeps the well's depth and takes an
      accent ring rather than filling solid. */
  const segmentAccentClass =
    'aria-pressed:bg-[var(--chrome-control-active-bg)] aria-pressed:text-accent aria-pressed:shadow-[inset_0_0_0_1px_var(--chrome-control-active-border)]';
</script>

<div
  class={cn(
    groupBaseClass,
    compact && 'h-[1.65rem]',
    fill && 'grid w-full auto-cols-fr grid-flow-col',
    className,
  )}
  role="group"
  aria-label={label}
  bind:clientWidth={width}
>
  {#each options as option (option.value)}
    <button
      type="button"
      class={cn(
        segmentBaseClass,
        compact && 'px-[.55rem] text-(length:--ctl-text)',
        option.tone === 'accent' && segmentAccentClass,
        option.class,
      )}
      aria-label={option.ariaLabel}
      aria-pressed={value === option.value}
      aria-busy={option.busy}
      disabled={option.disabled}
      onclick={() => onSelect(option.value)}
      {@attach tooltip(option.tip, { placement: tipPlacement })}
    >
      <span class:invisible={option.busy}>{option.label}</span>
      {#if option.busy}
        <span class="absolute inset-0 grid place-items-center" aria-hidden="true">
          <CircleNotchIcon class="animate-spin" size={12} weight="bold" />
        </span>
      {/if}
      {#if option.badge !== undefined}
        <span class="rounded-full bg-control-on px-[.3rem] text-(length:--ctl-text-xs) tabular-nums"
          >{option.badge}</span
        >
      {/if}
    </button>
  {/each}
</div>
