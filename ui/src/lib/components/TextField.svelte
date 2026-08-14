<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from 'svelte/elements';
  import { cn } from './classNames';

  /**
   * The one text input: the song's note field, every rename-in-place, the
   * "Save as…" name box, the filter at the top of a menu.
   */
  interface Props extends Omit<HTMLInputAttributes, 'class' | 'value' | 'size'> {
    value?: string;
    size?: 'sm' | 'md';
    /** `field` is the resting recessed well; `editing` is the rename look —
        already focused when it appears, so it announces itself with the accent
        border rather than waiting for `:focus`; `flush` is the filter box at
        the head of a menu, which keeps only its bottom hairline. */
    emphasis?: 'field' | 'editing' | 'flush';
    /**
     * The input element, for callers that focus or select it. A `bind:this` on
     * a component yields the component instance, not the node, so the node has
     * to come back through a prop.
     */
    element?: HTMLInputElement;
    class?: ClassValue;
  }

  let {
    value = $bindable(''),
    size = 'md',
    emphasis = 'field',
    element = $bindable(),
    class: className,
    ...rest
  }: Props = $props();

  const baseClass =
    'min-w-0 rounded-control-sm border border-control-edge-soft bg-field font-sans font-medium text-ink [transition:var(--ctl-transition)] placeholder:text-muted focus:border-accent focus:outline-none';

  const sizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: 'px-[.35rem] py-[.18rem] text-[length:var(--ctl-text)]',
    md: 'px-2 py-[.28rem] text-[.8rem]',
  };

  const emphasisClass: Record<NonNullable<Props['emphasis']>, string> = {
    field: '',
    editing: 'font-[550] border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]',
    flush:
      'rounded-none border-x-0 border-t-0 border-b border-control-edge-soft focus:border-control-edge-soft',
  };
</script>

<input
  type="text"
  {...rest}
  bind:this={element}
  bind:value
  class={cn(baseClass, sizeClass[size], emphasisClass[emphasis], className)}
/>
