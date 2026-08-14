<script lang="ts">
  import { CaretDownIcon, CircleNotchIcon, DotsThreeIcon } from 'phosphor-svelte';
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import Popover from './Popover.svelte';
  import { tooltip } from './tooltip.svelte';
  import { shortcutIndex } from '../keyboardShortcuts';
  import { cn } from './classNames';

  /**
   * The rig/scene switcher in the toolbar: a small uppercase tag naming the
   * collection, one segment per item, and a caret segment on the right.
   * Segments that don't fit the width budget collapse behind the caret,
   * whose popover lists just the hidden items in perform mode and the full
   * management menu (the `menu` snippet) in edit mode — where the caret is
   * always present, because the menu is the only home of rename/delete/new.
   * That difference is visible on the button itself: edit mode swaps the
   * caret for the "more actions" ellipsis in the accent colour, so a caret
   * that was already on screen for overflow still announces that it now
   * holds the management actions too.
   *
   * The group sizes itself to its fitted content so neighbouring toolbar
   * controls pack tightly against it. It cannot measure the space it may
   * take without feeding back into that measurement, so the parent supplies
   * the budget via `maxWidth` (see TopToolbar's toolbar halves).
   *
   * It always wears the chrome skin (`--chrome-control-*`): a switcher only
   * ever appears on the toolbar, alongside the Perform/Edit toggle it matches.
   */
  interface Item {
    id: string;
    name: string;
  }

  interface Props {
    items: Item[];
    /** The item currently loaded/applied, if any — pinned always-visible. */
    activeId?: string | null;
    /** Item awaiting engine convergence — its segment shows a spinner. */
    pendingId?: string | null;
    /** Edit mode keeps the caret permanently and swaps its popover for the
        management `menu` snippet. */
    editMode: boolean;
    /** Uppercase tag naming the collection: "Rig", "Scene". */
    tag: string;
    /** Group aria-label: "Rigs". */
    groupLabel: string;
    /** Muted placeholder segment when there are no items: "No rig". */
    noneLabel: string;
    /** Caret aria-label in edit mode: "Manage rigs". */
    menuLabel: string;
    /** Caret aria-label / overflow-list label in perform mode: "More rigs". */
    moreLabel: string;
    /** The active item has unsaved changes — shows a dot on its segment. */
    dirty?: boolean;
    /** Width budget granted by the parent, px; 0 means "not measured yet",
        which renders everything (the first real measurement follows within
        the same frame). */
    maxWidth?: number;
    /** Order-derived keys assigned to the leading items in Perform mode. */
    shortcutKeys?: readonly string[];
    /** Operational guard supplied by the rack (busy, standby and dialogs). */
    shortcutsEnabled?: boolean;
    onSelect: (id: string) => void;
    /** Reset per-open menu state owned outside the snippet (the popover's
        contents themselves remount on every open). */
    onMenuOpen?: () => void;
    /** Edit-mode management menu; call `close` to dismiss the popover. */
    menu?: Snippet<[() => void]>;
  }

  let {
    items,
    activeId = null,
    pendingId = null,
    editMode,
    tag,
    groupLabel,
    noneLabel,
    menuLabel,
    moreLabel,
    dirty = false,
    maxWidth = 0,
    shortcutKeys = [],
    shortcutsEnabled = false,
    onSelect,
    onMenuOpen,
    menu,
  }: Props = $props();

  const MENU_MAX_HEIGHT = 320; // px

  // Width taken by the caret segment when present.
  const CARET_WIDTH = 32; // px
  // The group frame around the segments: 2px padding + 1px border per side.
  const FRAME_WIDTH = 6; // px
  // Fit slack so a measurement landing exactly on the edge cannot flicker
  // between layouts on subpixel rounding.
  const FIT_MARGIN = 8; // px

  let open = $state(false);

  // Width of the tag panel incl. its divider rule (a dimension binding —
  // resize observed for us).
  let tagWidth = $state(0);

  // Natural segment width per item id, read off the hidden measuring row.
  // Keyed by id and re-measured on rename (the attachment closes over the
  // name), so the fit below always works from current text.
  let measured = $state<Record<string, number>>({});

  function measure(id: string, name: string) {
    return (node: HTMLElement) => {
      void name; // re-run the attachment when the label text changes
      measured[id] = node.offsetWidth;
      return () => {
        delete measured[id];
      };
    };
  }

  // Greedy left-to-right fit into the granted budget, caret reserved whenever
  // it will render. The pending item (or otherwise the active item) never
  // overflows: if it lands past the cut, trailing fitted items are dropped
  // until it can sit at the end.
  const layout = $derived.by(() => {
    if (items.length === 0) return { visible: [] as Item[], hidden: [] as Item[] };
    const widths = items.map((item) => measured[item.id]);
    // First frame, before the hidden row / granted budget have been measured.
    if (maxWidth <= 0 || widths.some((w) => w === undefined)) return { visible: items, hidden: [] };

    const budget = maxWidth - FRAME_WIDTH - tagWidth - FIT_MARGIN;
    const total = widths.reduce((sum, w) => sum + w!, 0);
    if (total + (editMode ? CARET_WIDTH : 0) <= budget) return { visible: items, hidden: [] };

    const fitBudget = budget - CARET_WIDTH;
    let used = 0;
    let count = 0;
    while (count < items.length && used + widths[count]! <= fitBudget) {
      used += widths[count]!;
      count++;
    }

    let visible = items.slice(0, count);
    const pinnedIndex = items.findIndex((item) => item.id === (pendingId ?? activeId));
    if (pinnedIndex >= count) {
      const pinnedWidth = widths[pinnedIndex]!;
      while (count > 0 && used + pinnedWidth > fitBudget) {
        count--;
        used -= widths[count]!;
      }
      visible = [...items.slice(0, count), items[pinnedIndex]];
    }
    // Never collapse to a bare caret: the current (or first) item always
    // shows, truncating via the label's max-width if it must.
    if (visible.length === 0) visible = [items[pinnedIndex >= 0 ? pinnedIndex : 0]];

    const shown = new Set(visible.map((item) => item.id));
    return { visible, hidden: items.filter((item) => !shown.has(item.id)) };
  });

  const caretShown = $derived(editMode || layout.hidden.length > 0);

  // Reveal the management caret as edit mode turns on, collapsing its exact
  // footprint so the neighbouring switcher segments slide rather than jump.
  function caretReveal(_node: Element) {
    return {
      duration: prefersReducedMotion.current ? 0 : 240,
      easing: cubicOut,
      css: (t: number) =>
        `overflow: hidden; min-width: 0; width: ${t * CARET_WIDTH}px; opacity: ${t};`,
    };
  }

  function close() {
    open = false;
  }

  function selectHidden(id: string) {
    onSelect(id);
    close();
  }

  function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return (
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ) !== null
    );
  }

  /** Perform-mode shortcuts share the exact selection path used by a click. */
  function handleShortcut(event: KeyboardEvent) {
    if (
      !shortcutsEnabled ||
      editMode ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing
    )
      return;
    if (event.ctrlKey || event.altKey || event.metaKey || isTextEntry(event.target)) return;

    const index = shortcutIndex(event.key, shortcutKeys);
    const item = index >= 0 ? items[index] : undefined;
    if (!item) return;

    event.preventDefault();
    close();
    onSelect(item.id);
  }

  function shortcutFor(item: Item): string | undefined {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    return index >= 0 ? shortcutKeys[index] : undefined;
  }

  const groupClass =
    'inline-flex h-9 items-center rounded-control-md border border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] p-0.5 shadow-[var(--chrome-control-shadow)]';
  const segmentClass =
    'inline-flex h-full cursor-pointer items-center justify-center rounded-control-sm border-0 bg-transparent px-[.85rem] text-[.8rem] font-semibold text-[color:var(--chrome-control-text)] [transition:background-color_140ms_ease,color_140ms_ease,box-shadow_140ms_ease] hover:bg-[var(--chrome-control-hover-bg)] hover:text-ink focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)]';
  // The selected segment wears the same skin as the selected side of the
  // Perform/Edit toggle it sits beside: neutral in perform mode, accent in
  // edit mode — so "what mode am I in" reads the same across the toolbar.
  const selectedClass = $derived(
    editMode
      ? 'aria-pressed:bg-[var(--chrome-control-active-bg)] aria-pressed:text-accent aria-pressed:shadow-[inset_0_0_0_1px_var(--chrome-control-active-border)]'
      : 'aria-pressed:bg-[var(--chrome-control-selected-bg)] aria-pressed:text-ink aria-pressed:shadow-[inset_0_0_0_1px_var(--chrome-control-selected-border)]',
  );
</script>

<svelte:window onkeydown={handleShortcut} />

<div class="relative inline-flex min-w-0">
  <!-- Hidden measuring row: every item at its natural width. Absolutely
       positioned so it never affects layout (or the toolbar's max-content). -->
  <div class={cn(groupClass, 'pointer-events-none invisible absolute')} aria-hidden="true">
    {#each items as item (item.id)}
      <button
        type="button"
        class={segmentClass}
        tabindex="-1"
        {@attach measure(item.id, item.name)}
      >
        <span class="max-w-36 truncate">{item.name}</span>
      </button>
    {/each}
  </div>

  <div class={groupClass} role="group" aria-label={groupLabel}>
    <span
      class="flex flex-none items-center self-stretch py-0 pr-[.55rem] pl-[.6rem] text-[length:var(--ctl-text-xs)] font-bold tracking-[.1em] text-[color:var(--chrome-control-tag-text)] uppercase select-none"
      bind:offsetWidth={tagWidth}>{tag}</span
    >
    {#if items.length === 0}
      <span class={cn(segmentClass, 'cursor-default text-muted')}>{noneLabel}</span>
    {/if}
    {#each layout.visible as item (item.id)}
      {@const isActive = item.id === activeId}
      {@const shortcut = shortcutFor(item)}
      <button
        type="button"
        class={cn(segmentClass, selectedClass, 'relative flex-none')}
        aria-pressed={isActive}
        aria-busy={pendingId === item.id}
        aria-keyshortcuts={shortcutsEnabled && !editMode ? shortcut : undefined}
        onclick={() => onSelect(item.id)}
      >
        <!-- The label stays in the layout while pending — hidden, with the
             spinner overlaid — so the segment (and the group) keeps its
             width instead of jumping around the spinner. -->
        <span class="max-w-36 truncate" class:invisible={pendingId === item.id}>{item.name}</span>
        {#if pendingId === item.id}
          <span class="absolute inset-0 grid place-items-center">
            <CircleNotchIcon class="animate-spin" size={14} weight="bold" />
          </span>
        {/if}
        {#if isActive && dirty}
          <span
            class="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-accent shadow-glow-accent-sm"
            aria-hidden="true"
          ></span>
        {/if}
      </button>
    {/each}
    {#if caretShown}
      <span class="flex flex-none self-stretch" transition:caretReveal>
        <Popover
          bind:open
          maxHeight={MENU_MAX_HEIGHT}
          panelClass="min-w-56"
          ariaHasPopup={editMode ? 'menu' : 'listbox'}
          onOpen={onMenuOpen}
        >
          {#snippet trigger(props)}
            <button
              {...props}
              class={cn(
                segmentClass,
                'relative w-8 flex-none p-0',
                editMode && 'text-accent hover:bg-accent/14 hover:text-accent',
              )}
              aria-label={editMode ? menuLabel : moreLabel}
              {@attach tooltip(editMode ? menuLabel : moreLabel)}
            >
              <!-- Both glyphs stay mounted and stacked so the swap crossfades
                   in place instead of resizing the button mid-transition. -->
              <span
                class={cn(
                  'absolute inset-0 grid scale-[.72] place-items-center opacity-0 [transition:opacity_180ms_ease,scale_180ms_ease]',
                  !editMode && 'scale-100 opacity-100',
                )}
              >
                <CaretDownIcon size={13} weight="bold" />
              </span>
              <span
                class={cn(
                  'absolute inset-0 grid scale-[.72] place-items-center opacity-0 [transition:opacity_180ms_ease,scale_180ms_ease]',
                  editMode && 'scale-100 opacity-100',
                )}
              >
                <DotsThreeIcon size={18} weight="bold" />
              </span>
            </button>
          {/snippet}

          {#if editMode && menu}
            {@render menu(close)}
          {:else}
            <ul class="overflow-y-auto py-1" role="listbox" aria-label={moreLabel}>
              {#each layout.hidden as item (item.id)}
                {@const shortcut = shortcutFor(item)}
                <li role="option" aria-selected={item.id === activeId}>
                  <button
                    type="button"
                    class={cn(
                      'block w-full truncate px-3 py-1.5 text-left text-[0.8rem] hover:bg-ink/10',
                      item.id === activeId
                        ? editMode
                          ? 'text-accent'
                          : 'text-ink'
                        : 'text-ink/80',
                    )}
                    aria-keyshortcuts={shortcutsEnabled ? shortcut : undefined}
                    onclick={() => selectHidden(item.id)}
                  >
                    {item.name}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </Popover>
      </span>
    {/if}
  </div>
</div>
