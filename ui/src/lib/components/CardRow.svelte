<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';
  import { cn } from './classNames';

  /**
   * One labelled setting inside a {@link Card}: its name on the left, the
   * control that changes it on the right.
   *
   * The row owns the card's padding — see Card's note on why the card itself
   * has none — so every row in a panel lines up regardless of which control it
   * holds.
   */
  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
    /** What the control changes. Plain text; the control keeps its own
        accessible name, so this is never the only label. */
    label: string;
    class?: ClassValue;
    /** The control itself. */
    children: Snippet;
  }

  let { label, class: className, children, ...rest }: Props = $props();
</script>

<div
  {...rest}
  class={cn(
    'flex min-h-[2.4rem] flex-none items-center justify-between gap-3 px-[.6rem] py-[.35rem] font-mono text-[length:var(--ctl-text)] leading-normal font-[650] text-control-body',
    className,
  )}
>
  <span class="min-w-0 truncate">{label}</span>
  {@render children()}
</div>
