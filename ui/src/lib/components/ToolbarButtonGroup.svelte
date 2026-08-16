<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';
  import { cn } from './classNames';

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'aria-label'> {
    label: string;
    class?: ClassValue;
    children: Snippet;
  }

  let { label, class: className, children, ...rest }: Props = $props();
</script>

<div
  {...rest}
  class={cn('toolbar-button-group inline-flex items-center', className)}
  role="group"
  aria-label={label}
>
  {@render children()}
</div>

<style>
  /* Unlayered so these structural overrides outrank each child's utilities. */
  .toolbar-button-group > :global(button) {
    border-radius: 0;
  }
  .toolbar-button-group > :global(button + button) {
    margin-left: -1px;
  }
  .toolbar-button-group > :global(button:first-child) {
    border-radius: 0.45rem 0 0 0.45rem;
  }
  .toolbar-button-group > :global(button:last-child) {
    border-radius: 0 0.45rem 0.45rem 0;
  }
  .toolbar-button-group > :global(button:hover),
  .toolbar-button-group > :global(button:focus-visible) {
    position: relative;
    z-index: 1;
  }
</style>
