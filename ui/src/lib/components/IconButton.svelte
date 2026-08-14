<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';
  import { tooltip, type TooltipPlacement } from './tooltip.svelte';
  import { cn } from './classNames';

  /**
   * The square icon action: the tool rail, the panel close, the
   * rename/delete pair on a list row, the metronome's ± steps.
   *
   * There is no `active` prop: the pressed and expanded looks read off
   * `aria-pressed` / `aria-expanded`, which ride through the spread. One
   * source of truth, so the paint can never disagree with what a screen reader
   * is told.
   */
  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'aria-label'> {
    /** Required. Becomes `aria-label`, and the tooltip when `tip` is omitted —
        an icon with no name is unusable to anything that can't see it. */
    label: string;
    /** Overrides the tooltip when it should say more than the label does. */
    tip?: string;
    tipPlacement?: TooltipPlacement;
    /** `xs` 1.5rem (row actions, panel close), `sm` 1.75rem, `md` 2.3rem (the
        tool rail). */
    size?: 'xs' | 'sm' | 'md';
    /** `plain` is borderless UI chrome; `canvas` is the bordered, menu-backed
        control used directly on the rack surface. */
    variant?: 'plain' | 'canvas';
    tone?: 'neutral' | 'accent' | 'warn';
    round?: boolean;
    /**
     * Stay hidden until the enclosing row sets `--row-reveal: 1` on hover.
     * Still appears on its own hover or keyboard focus — a pointer-only
     * affordance would put the action out of reach of the keyboard.
     */
    reveal?: boolean;
    class?: ClassValue;
    children: Snippet;
  }

  let {
    label,
    tip,
    tipPlacement = 'top',
    size = 'xs',
    variant = 'plain',
    tone = 'neutral',
    round = false,
    reveal = false,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const baseClass =
    'inline-flex flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted [transition:var(--ctl-transition)] enabled:hover:bg-control-hover enabled:hover:text-ink aria-expanded:bg-control-on aria-expanded:text-ink aria-pressed:bg-control-on aria-pressed:text-ink disabled:cursor-default disabled:opacity-(--disabled-opacity) focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--ctl-focus-offset,var(--focus-in))]';

  const sizeClass: Record<NonNullable<Props['size']>, string> = {
    xs: 'h-6 w-6 rounded-control-sm',
    sm: 'h-7 w-7 rounded-control-sm',
    md: 'h-[2.3rem] w-[2.3rem] rounded-control-md',
  };

  const variantClass: Record<NonNullable<Props['variant']>, string> = {
    plain: '',
    canvas:
      'h-9 min-w-9 rounded-[6px] border border-[color:color-mix(in_srgb,var(--color-ink)_28%,transparent)] bg-menu shadow-[0_3px_8px_color-mix(in_srgb,var(--color-void)_28%,transparent)] [transition:all_.2s_ease] enabled:hover:border-accent enabled:hover:bg-menu enabled:hover:text-ink focus-visible:border-accent focus-visible:bg-menu focus-visible:text-ink aria-pressed:border-accent aria-pressed:bg-[color:color-mix(in_srgb,var(--color-accent)_18%,var(--color-menu))] aria-pressed:text-accent aria-pressed:shadow-[0_0_12px_color-mix(in_srgb,var(--color-accent)_35%,transparent),inset_0_0_8px_color-mix(in_srgb,var(--color-accent)_10%,transparent)]',
  };

  const toneClass: Record<NonNullable<Props['tone']>, string> = {
    neutral: '',
    accent:
      'enabled:hover:text-[color:var(--ctl-accent,var(--color-accent))] focus-visible:text-[color:var(--ctl-accent,var(--color-accent))] aria-pressed:text-[color:var(--ctl-accent,var(--color-accent))]',
    warn: 'enabled:hover:text-warn focus-visible:text-warn',
  };
</script>

<button
  type="button"
  {...rest}
  aria-label={label}
  class={cn(
    baseClass,
    sizeClass[size],
    variantClass[variant],
    toneClass[tone],
    round && 'rounded-full',
    reveal && 'opacity-(--row-reveal) hover:opacity-100 focus-visible:opacity-100',
    className,
  )}
  {@attach tooltip(tip ?? label, { placement: tipPlacement })}
>
  {@render children()}
</button>
