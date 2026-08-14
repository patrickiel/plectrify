<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';
  import { tooltip, type TooltipPlacement } from './tooltip.svelte';
  import { cn } from './classNames';

  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'aria-label'> {
    /** Accessible name for the control. */
    label: string;
    tip?: string;
    tipPlacement?: TooltipPlacement;
    /** `sm` matches compact menu controls; `md` matches the top toolbar. */
    size?: 'sm' | 'md';
    iconOnly?: boolean;
    tone?: 'neutral' | 'accent' | 'warn';
    class?: ClassValue;
    children: Snippet;
  }

  let {
    label,
    tip,
    tipPlacement = 'top',
    size = 'md',
    iconOnly = false,
    tone = 'neutral',
    class: className,
    children,
    ...rest
  }: Props = $props();

  // Sunk into the chrome frame's own well (`--chrome-control-*`), so it sits on
  // the same surface as the switchers beside it.
  const baseClass =
    'inline-flex cursor-pointer items-center justify-center gap-[.4rem] rounded-control-md border border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] font-semibold text-muted shadow-[var(--chrome-control-shadow)] [transition:background-color_140ms_ease,border-color_140ms_ease,color_140ms_ease,opacity_140ms_ease] enabled:hover:border-[color:var(--chrome-control-active-border)] enabled:hover:bg-[var(--chrome-control-hover-bg)] enabled:hover:text-ink aria-expanded:border-[color:var(--chrome-control-active-border)] aria-expanded:bg-[var(--chrome-control-hover-bg)] aria-expanded:text-ink disabled:cursor-default disabled:opacity-(--disabled-opacity) focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)]';

  const sizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: 'h-[1.65rem] px-[.55rem] text-[length:var(--ctl-text)]',
    md: 'h-9 px-[.7rem] text-[.8rem]',
  };

  const iconSizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: 'w-[1.65rem] px-0',
    md: 'w-9 px-0',
  };

  const toneClass: Record<NonNullable<Props['tone']>, string> = {
    neutral: '',
    accent:
      'enabled:border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] enabled:bg-accent/10 enabled:text-accent enabled:hover:border-[color:color-mix(in_srgb,var(--color-accent)_70%,transparent)] enabled:hover:bg-accent/18 enabled:hover:text-accent',
    warn: 'enabled:hover:border-[color:color-mix(in_srgb,var(--color-warn)_45%,transparent)] enabled:hover:text-warn focus-visible:border-[color:color-mix(in_srgb,var(--color-warn)_45%,transparent)] focus-visible:text-warn',
  };
</script>

<button
  type="button"
  {...rest}
  aria-label={label}
  class={cn(
    baseClass,
    sizeClass[size],
    iconOnly && iconSizeClass[size],
    toneClass[tone],
    className,
  )}
  {@attach tooltip(tip, { placement: tipPlacement })}
>
  {@render children()}
</button>
