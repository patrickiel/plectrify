<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';
  import { tooltip, type TooltipPlacement } from './tooltip.svelte';
  import { cn } from './classNames';

  /**
   * A full-width row in a list you pick from: a song, a setlist, an archived
   * looper session, a settings menu entry, an About link.
   *
   * Content stays a snippet in the caller, which keeps the caller's scope, so
   * a rule like `.is-active .row-name` on the row's own labels goes on
   * working. Only this component's `<button>` loses the caller's hash.
   */
  interface Props extends Omit<HTMLButtonAttributes, 'class'> {
    /** `stack` puts the name over its chips and notes (song rows); `inline`
        keeps everything on one line. */
    layout?: 'stack' | 'inline';
    dense?: boolean;
    tip?: string;
    tipPlacement?: TooltipPlacement;
    class?: ClassValue;
    children: Snippet;
  }

  let {
    layout = 'inline',
    dense = false,
    tip,
    tipPlacement = 'top',
    class: className,
    children,
    ...rest
  }: Props = $props();

  const baseClass =
    'flex min-w-0 flex-1 cursor-pointer items-center gap-[.4rem] rounded-control-sm border-0 bg-transparent px-[var(--ctl-pad-x,.5rem)] py-[var(--ctl-pad-y,.45rem)] text-left text-control-body [transition:var(--ctl-transition)] enabled:hover:bg-control-hover disabled:cursor-default disabled:opacity-(--disabled-opacity) focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--ctl-focus-offset,var(--focus-in))]';
</script>

<button
  type="button"
  {...rest}
  class={cn(
    baseClass,
    layout === 'stack' && 'flex-col items-start gap-[.12rem]',
    dense && '[--ctl-pad-x:.4rem] [--ctl-pad-y:.35rem]',
    className,
  )}
  {@attach tooltip(tip, { placement: tipPlacement })}
>
  {@render children()}
</button>
