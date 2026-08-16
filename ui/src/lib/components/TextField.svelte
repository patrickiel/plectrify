<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from 'svelte/elements';
  import { XIcon } from 'phosphor-svelte';
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
    /**
     * Show a clear button inside the field's right edge while it holds text —
     * for a filter, where emptying the box is a thing the user does as often
     * as typing in it and select-all-delete is the only alternative. It costs
     * the field a wrapper, so `class` then lands on that wrapper (which is
     * where a `flex-1` wants to be anyway) and the input fills it.
     */
    clearable?: boolean;
    class?: ClassValue;
  }

  let {
    value = $bindable(''),
    size = 'md',
    emphasis = 'field',
    element = $bindable(),
    clearable = false,
    class: className,
    ...rest
  }: Props = $props();

  const showClear = $derived(clearable && value !== '');

  function clear() {
    value = '';
    // Back to the field: clearing is a step in filtering, not the end of it.
    element?.focus();
  }

  // No border colour in the base: every emphasis names its own, so two
  // conflicting border utilities never ride the same element (which one wins
  // would depend on generated-CSS order, not call-site order).
  const baseClass =
    'min-w-0 rounded-control-sm border bg-field font-sans font-medium text-ink [transition:var(--ctl-transition)] placeholder:text-muted focus:border-accent focus:outline-none';

  const sizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: 'px-[.35rem] py-[.18rem] text-[length:var(--ctl-text)]',
    md: 'px-2 py-[.28rem] text-[.8rem]',
  };

  // The resting field wears the chrome-control edge and shadow — the same
  // skin as Button's pill and Select's trigger — so an input sitting beside
  // them reads as the same family of control; only its well (`bg-field`)
  // says it is one you type into. `editing` and `flush` are transient or
  // deliberately bare, so neither carries the shadow.
  const emphasisClass: Record<NonNullable<Props['emphasis']>, string> = {
    field: 'border-[color:var(--chrome-control-border)] shadow-[var(--chrome-control-shadow)]',
    editing: 'font-[550] border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]',
    flush:
      'rounded-none border-x-0 border-t-0 border-b border-control-edge-soft focus:border-control-edge-soft',
  };
</script>

{#snippet field(extra: ClassValue | undefined)}
  <input
    type="text"
    {...rest}
    bind:this={element}
    bind:value
    class={cn(baseClass, sizeClass[size], emphasisClass[emphasis], extra)}
  />
{/snippet}

{#if clearable}
  <div class={cn('relative flex items-center', className)}>
    <!-- Room on the right for the button, kept whether or not it is showing:
         reserving it means the text under the cursor does not shift the moment
         the first character is typed. -->
    {@render field('w-full pr-[1.4rem]')}
    {#if showClear}
      <!-- Out of the tab order: it is a shortcut for a thing the keyboard can
           already do, and a stop between the filter and what it filters is one
           more press on the way to the list every time. -->
      <button
        type="button"
        tabindex={-1}
        class="absolute right-[.3rem] grid size-[1rem] place-items-center rounded-full text-muted transition hover:bg-ink/10 hover:text-ink"
        onclick={clear}
        aria-label="Clear"
      >
        <XIcon size={11} weight="bold" />
      </button>
    {/if}
  </div>
{:else}
  {@render field(className)}
{/if}
