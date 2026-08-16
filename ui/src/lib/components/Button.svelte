<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';
  import { tooltip, type TooltipPlacement } from './tooltip.svelte';
  import { learnRingClass, type LearnState } from './learnSkin';
  import { cn } from './classNames';

  /**
   * The sidebar's text button — the song transport, the looper's verbs, the
   * metronome's play bar, Refresh, Clear all, the MIDI learn switch.
   *
   * Sizing travels as a prop rather than as a `.tool-large .x-btn` descendant
   * rule, which would stop matching the moment the button moved in here. For a
   * one-off deviation, set `--ctl-pad-y` / `--ctl-pad-x` / `--ctl-focus-offset`
   * on any ancestor: custom properties inherit across a component boundary,
   * class selectors do not.
   */
  interface Props extends Omit<HTMLButtonAttributes, 'class'> {
    /** `pill` is the bordered control; `ghost` drops the border; `link` reads
        as inline prose ("Use what's loaded now"). */
    variant?: 'pill' | 'ghost' | 'link';
    /** `lg` is the maximized-panel step — pass `size={large ? 'lg' : 'md'}`. */
    size?: 'sm' | 'md' | 'lg';
    /** `accent` reads `--ctl-accent`, so a tool whose state has its own colour
        (`--looper-color`, `--metronome-color`) re-points it on an ancestor and
        the button follows without a new variant. */
    tone?: 'neutral' | 'accent' | 'warn' | 'danger';
    /** Fill the grid/flex cell — the transport row, the verb grid, the play bar. */
    block?: boolean;
    /** MIDI-learn skin. Build it with `learnStateOf(learn, action)`; `off`
        renders plain. Replaces the `class:learn-*` triple, which is illegal on
        a component. */
    learn?: LearnState;
    /**
     * Tooltip text. Mutually exclusive with a call-site
     * `{@attach tooltip(...)}` — both register the same listeners on the same
     * node and would fight. Use the attachment when you need `positionFrom`.
     */
    tip?: string;
    tipPlacement?: TooltipPlacement;
    class?: ClassValue;
    children: Snippet;
  }

  let {
    variant = 'pill',
    size = 'md',
    tone = 'neutral',
    block = false,
    learn = 'off',
    tip,
    tipPlacement = 'top',
    class: className,
    children,
    ...rest
  }: Props = $props();

  const baseClass =
    'inline-flex cursor-pointer items-center justify-center gap-1 border border-transparent bg-transparent font-mono font-semibold tracking-[.04em] text-control-body [transition:var(--ctl-transition)] focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--ctl-focus-offset,var(--focus-tight))]';

  const sizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: '[--ctl-pad-x:.5rem] [--ctl-pad-y:.32rem] text-[length:var(--ctl-text-sm)]',
    md: '[--ctl-pad-x:.7rem] [--ctl-pad-y:.6rem] text-[length:var(--ctl-text)]',
    lg: '[--ctl-pad-x:.9rem] [--ctl-pad-y:.95rem] text-[length:var(--ctl-text-lg)]',
  };

  // A pill wears the chrome skin (`--chrome-control-*`) — the same well the
  // toolbar's Perform/Edit toggle sits in, so a button in a tool panel and a
  // button in the top bar are visibly the same control.
  const variantClass: Record<NonNullable<Props['variant']>, string> = {
    pill: 'rounded-control-md border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] shadow-[var(--chrome-control-shadow)] [padding:var(--ctl-pad-y,.6rem)_var(--ctl-pad-x,.7rem)] enabled:hover:border-[color:var(--chrome-control-active-border)] enabled:hover:bg-[var(--chrome-control-hover-bg)] enabled:hover:text-ink focus-visible:border-[color:var(--chrome-control-active-border)] focus-visible:text-ink disabled:cursor-default disabled:border-[color:var(--chrome-control-disabled-border)] disabled:bg-[var(--chrome-control-disabled-bg)] disabled:text-control-off disabled:shadow-none',
    ghost:
      'rounded-control-sm [padding:var(--ctl-pad-y,.3rem)_var(--ctl-pad-x,.4rem)] text-muted enabled:hover:bg-control-hover enabled:hover:text-ink disabled:cursor-default disabled:opacity-(--disabled-opacity)',
    link: 'p-0 font-sans text-[length:var(--ctl-text-sm)] font-[550] tracking-normal text-[color:color-mix(in_srgb,var(--ctl-accent,var(--color-accent))_85%,transparent)] enabled:hover:text-[color:var(--ctl-accent,var(--color-accent))] enabled:hover:underline disabled:cursor-default disabled:opacity-(--disabled-opacity)',
  };

  const toneClass: Record<NonNullable<Props['tone']>, string> = {
    neutral: '',
    accent:
      'enabled:border-[color:color-mix(in_srgb,var(--ctl-accent,var(--color-accent))_40%,transparent)] enabled:bg-[color:color-mix(in_srgb,var(--ctl-accent,var(--color-accent))_10%,transparent)] enabled:text-[color:var(--ctl-accent,var(--color-accent))] enabled:hover:border-[color:var(--ctl-accent,var(--color-accent))] focus-visible:border-[color:var(--ctl-accent,var(--color-accent))] focus-visible:text-[color:var(--ctl-accent,var(--color-accent))]',
    warn: 'enabled:hover:border-[color:color-mix(in_srgb,var(--color-warn)_60%,transparent)] enabled:hover:bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] enabled:hover:text-warn focus-visible:border-[color:color-mix(in_srgb,var(--color-warn)_60%,transparent)] focus-visible:bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] focus-visible:text-warn',
    danger:
      'enabled:border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] enabled:text-danger enabled:hover:border-[color:color-mix(in_srgb,var(--color-danger)_55%,transparent)] enabled:hover:bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] focus-visible:border-[color:color-mix(in_srgb,var(--color-danger)_55%,transparent)] focus-visible:bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] focus-visible:text-danger',
  };

  // A control the looper disables (Undo with nothing to undo) is still a learn
  // target, so the disabled chrome has to step back out of the way — otherwise
  // half the row reads as unavailable exactly when it isn't.
  const learnEnabledClass =
    'disabled:cursor-pointer disabled:border-[color:var(--chrome-control-border)] disabled:bg-[var(--chrome-control-bg)] disabled:text-inherit disabled:shadow-[var(--chrome-control-shadow)]';
  // …and `bound` keeps its fill through that reset: `:disabled` outranks the
  // plain `bg-*` the skin sets, so it has to be restated in the same modifier.
  const learnBoundFillClass =
    'disabled:bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)]';
</script>

<!-- `type` before the spread so a caller can still ask for "submit"; `class`
     after it, since `class` is not in `rest` and must not be overwritten. -->
<button
  type="button"
  {...rest}
  class={cn(
    baseClass,
    sizeClass[size],
    variantClass[variant],
    toneClass[tone],
    block && 'w-full [--ctl-pad-x:0]',
    learn !== 'off' && learnEnabledClass,
    learnRingClass(learn),
    learn === 'bound' && learnBoundFillClass,
    className,
  )}
  {@attach tooltip(tip, { placement: tipPlacement })}
>
  {@render children()}
</button>
