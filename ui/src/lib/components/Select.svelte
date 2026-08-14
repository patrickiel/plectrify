<script lang="ts">
  import { CaretDownIcon } from 'phosphor-svelte';
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import Popover from './Popover.svelte';
  import TextField from './TextField.svelte';
  import { cn } from './classNames';

  interface Option {
    value: string;
    label: string;
  }

  interface Props {
    options: Option[];
    /** Text shown on the trigger when nothing is selected (or after a reset). */
    placeholder?: string;
    /** Currently selected value; empty string shows the placeholder. */
    value?: string;
    onSelect: (value: string) => void;
    disabled?: boolean;
    /** Extra classes for the trigger button (width, flex behaviour). */
    class?: ClassValue;
    /** Trigger scale. `md` is the sidebar/rack default; `sm` is the
        settings-menu and editor-row scale. */
    size?: 'sm' | 'md';
    /**
     * `glow` is the rack and toolbar skin — an accent glow on hover, correct
     * at 2.25rem on a module card. `plain` is the sidebar's quieter
     * border-brighten, which is what reads right at the 1.65rem the panels
     * use. Defaults to `glow` so the rack's call sites are untouched.
     */
    variant?: 'glow' | 'plain';
    /**
     * Custom trigger content. When provided, the default label/arrow trigger is
     * replaced by this snippet and only `class` styles the (bare) button — used
     * to render the in-place "+" knob placeholders.
     */
    trigger?: Snippet;
    /**
     * Notified whenever the menu opens or closes. The panel is portaled to
     * `<body>`, so a consumer that only reveals the trigger on hover has to
     * know the menu is up — the pointer moving onto it leaves the trigger.
     */
    onOpenChange?: (open: boolean) => void;
    /**
     * Hide the filter box. For a short list of fixed choices (delays, formats)
     * a search field is more chrome than the whole menu, and there is nothing
     * to search. Keyboard navigation moves to the list itself.
     */
    filterable?: boolean;
    /**
     * Placeholder for the filter box. Name what is being filtered — "Filter
     * parameters…" — because the menu is portaled and a long list scrolls the
     * trigger out of view, leaving a bare "Filter…" as the only label on
     * screen. Defaults to the bare form for lists whose contents are obvious.
     */
    filterPlaceholder?: string;
    /**
     * An action row pinned under the list — "New setlist…". It belongs here
     * rather than beside the trigger because making a new thing is part of
     * choosing one: the menu you open to pick is the menu you open when the
     * one you want doesn't exist yet. Handed `close` so it can dismiss the
     * menu once it has done its work.
     */
    footer?: Snippet<[() => void]>;
    'aria-label'?: string;
  }

  let {
    options,
    placeholder = 'Select…',
    value = '',
    onSelect,
    disabled = false,
    class: className = '',
    size = 'md',
    variant = 'glow',
    trigger: triggerContent,
    onOpenChange,
    filterable = true,
    filterPlaceholder = 'Filter…',
    footer,
    'aria-label': ariaLabel,
  }: Props = $props();

  const MENU_MAX_HEIGHT = 288; // px, matches max-h-72 below

  let open = $state(false);
  let filter = $state('');
  let highlight = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLUListElement | undefined = $state();

  // Report the state, and always report closed on teardown, so a consumer that
  // conditionally renders this Select can never be left thinking a menu of a
  // component it just destroyed is still open.
  $effect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  });

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '');

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  });

  function onFilterInput() {
    // Reset to the first match so the highlight never points past the list.
    highlight = 0;
  }

  function resetOnOpen() {
    filter = '';
    // Without a filter box there is nothing to type into, so open on the
    // current choice: arrow keys then step from where the user actually is.
    highlight = filterable
      ? 0
      : Math.max(
          0,
          options.findIndex((o) => o.value === value),
        );
    // Focus without scrolling the page (the panel is fixed-position).
    queueMicrotask(() => (filterable ? input : list)?.focus({ preventScroll: true }));
  }

  function choose(v: string) {
    onSelect(v);
    open = false;
  }

  /** Shared by the filter box and, when there is none, the list itself. */
  function onFilterKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        highlight = Math.min(highlight + 1, filtered.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        highlight = Math.max(highlight - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlight]) choose(filtered[highlight].value);
        break;
      // Escape is left to Popover, which closes the innermost menu and returns
      // focus to the trigger this panel took it from.
    }
  }

  // The well, not a translucent overlay: `--chrome-control-*` is what every
  // other control wears (Button's pill, the segmented groups), so a select
  // sitting beside them reads as the same depth in both themes — a
  // surface-relative ink tint floated above whatever card it landed on.
  //
  // Disabled follows the pill exactly, for the same reason: the well and its
  // edge thin out toward the surface rather than the whole control fading. A
  // select that dimmed while the buttons beside it receded would be the one
  // thing in the row still asking to be pressed.
  const triggerBaseClass =
    'flex cursor-pointer items-center justify-between gap-1 rounded-control-sm border border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] text-ink shadow-[var(--chrome-control-shadow)] [transition:var(--ctl-transition)] enabled:hover:border-[color:var(--chrome-control-active-border)] aria-expanded:border-[color:var(--chrome-control-active-border)] disabled:cursor-default disabled:border-[color:var(--chrome-control-disabled-border)] disabled:bg-[var(--chrome-control-disabled-bg)] disabled:text-control-off disabled:shadow-none focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)]';

  const triggerSizeClass: Record<NonNullable<Props['size']>, string> = {
    sm: 'px-[.35rem] py-[.18rem] text-[length:var(--ctl-text)]',
    md: 'px-2 py-[.28rem] text-[.8rem]',
  };

  const triggerVariantClass: Record<NonNullable<Props['variant']>, string> = {
    plain: '',
    glow: 'rounded-[.375rem] [transition:all_200ms] enabled:hover:border-accent enabled:hover:bg-accent/10 enabled:hover:text-accent enabled:hover:shadow-glow-accent-sm',
  };
</script>

<Popover bind:open maxHeight={MENU_MAX_HEIGHT} matchTriggerWidth onOpen={resetOnOpen}>
  {#snippet trigger(props)}
    {#if triggerContent}
      <button {...props} class={className} {disabled} aria-label={ariaLabel}>
        {@render triggerContent()}
      </button>
    {:else}
      <button
        {...props}
        class={cn(
          triggerBaseClass,
          triggerSizeClass[size],
          triggerVariantClass[variant],
          className,
        )}
        {disabled}
        aria-label={ariaLabel}
      >
        <span class="truncate">{selectedLabel || placeholder}</span>
        <CaretDownIcon size={14} class="shrink-0" />
      </button>
    {/if}
  {/snippet}

  {#if filterable}
    <TextField
      bind:element={input}
      bind:value={filter}
      size="sm"
      emphasis="flush"
      oninput={onFilterInput}
      onkeydown={onFilterKeydown}
      placeholder={filterPlaceholder}
      aria-label={filterPlaceholder}
    />
  {/if}
  <!-- `min-h-0` so a long list scrolls inside the panel's max height instead of
       pushing the footer out of it. -->
  <ul
    bind:this={list}
    class="min-h-0 overflow-y-auto py-1 focus:outline-none"
    role="listbox"
    aria-label={ariaLabel}
    tabindex={filterable ? undefined : -1}
    onkeydown={filterable ? undefined : onFilterKeydown}
  >
    {#each filtered as o, i (o.value)}
      <li role="option" aria-selected={o.value === value}>
        <button
          type="button"
          class="block w-full truncate px-2 py-1 text-left text-xs {i === highlight
            ? 'bg-accent/15 text-accent'
            : 'text-ink/80 hover:bg-ink/10'}"
          onmouseenter={() => (highlight = i)}
          onclick={() => choose(o.value)}
        >
          {o.label}
        </button>
      </li>
    {:else}
      <li class="px-2 py-2 text-center text-xs text-muted">No matches</li>
    {/each}
  </ul>
  {#if footer}
    <div class="flex-none border-t border-control-edge-hair px-1 py-1">
      {@render footer(() => (open = false))}
    </div>
  {/if}
</Popover>
