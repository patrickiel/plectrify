<script lang="ts">
  import { PencilSimpleIcon, TrashIcon } from 'phosphor-svelte';
  import type { Snippet } from 'svelte';
  import ReorderHandle from './ReorderHandle.svelte';
  import { VerticalReorder } from './verticalReorder.svelte';
  import InlineRenameInput from './InlineRenameInput.svelte';
  import RowButton from './RowButton.svelte';
  import IconButton from './IconButton.svelte';
  import InlineConfirmRow from './InlineConfirmRow.svelte';
  import SaveAsRow from './SaveAsRow.svelte';

  /**
   * The "manage named items" menu body behind the rig and scene switchers'
   * edit-mode caret: a reorderable list where each row can be selected,
   * renamed inline or delete-confirmed in place, and a footer with a "Save
   * current as…" row. Entity-specific extras (RigBar's "New rig" flow) render
   * through the footer snippets. Rendered inside a Popover, which mounts it
   * fresh on every open — so the per-open state below resets by itself.
   */
  interface Item {
    id: string;
    name: string;
  }

  interface Props {
    items: Item[];
    /** The item currently loaded, if any — tints its row. */
    activeId?: string | null;
    /** List aria-label: "Saved rigs". */
    listLabel: string;
    /** List placeholder when there are no items: "No saved rigs". */
    emptyLabel: string;
    /** Suggested name for the save-as input. */
    savePlaceholder: string;
    /** aria-label for the save-as input: "Rig name". */
    saveInputLabel: string;
    /** Whether there's anything worth saving (empty rack → nothing to save). */
    canSave: boolean;
    /** Perform-mode keys shown as a muted prefix for the leading items. */
    shortcutKeys?: readonly string[];
    onSelect: (id: string) => void;
    /** Save the current state as a new item under this name. */
    onSave: (name: string) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    /** Reorder the list — drives the menu and the switcher segments alike. */
    onMove: (id: string, toIndex: number) => void;
    /** Dismiss the popover hosting this panel. */
    close: () => void;
    /** Extra footer rows above the save-as row; `close` dismisses the menu. */
    footerTop?: Snippet<[{ close: () => void }]>;
    /** Extra footer rows below the save-as row. */
    footerBottom?: Snippet<[{ close: () => void }]>;
  }

  let {
    items,
    activeId = null,
    listLabel,
    emptyLabel,
    savePlaceholder,
    saveInputLabel,
    canSave,
    shortcutKeys = [],
    onSelect,
    onSave,
    onRename,
    onDelete,
    onMove,
    close,
    footerTop,
    footerBottom,
  }: Props = $props();

  const reorder = new VerticalReorder((from, to) => onMove(items[from].id, to));

  let saving = $state(false);
  // Id of the item being renamed inline.
  let editingId = $state('');
  // Deleting is unrecoverable, so the row asks first. Only ever one at a
  // time: starting a second confirm (or a rename) drops the pending one.
  let confirmingDeleteId = $state('');

  function select(id: string) {
    onSelect(id);
    close();
  }

  function beginRename(item: Item) {
    editingId = item.id;
    confirmingDeleteId = '';
  }

  function commitRename(value: string) {
    if (value.trim()) onRename(editingId, value);
    editingId = '';
  }

  function commitDelete(item: Item) {
    onDelete(item.id);
    confirmingDeleteId = '';
  }

  function commitSave(name: string) {
    // Empty is fine — the engine falls back to the suggested placeholder name.
    onSave(name);
    close();
  }
</script>

<ul
  class={['item-list overflow-y-auto py-1', reorder.listClass]}
  role="listbox"
  aria-label={listLabel}
  {...reorder.listAttrs}
>
  {#each items as item, i (item.id)}
    <li
      role="option"
      aria-selected={item.id === activeId}
      class={['flex items-center hover:[--row-reveal:1]', reorder.itemClass(i)]}
      {...reorder.itemAttrs(i)}
    >
      {#if editingId === item.id}
        <InlineRenameInput
          value={item.name}
          ariaLabel="Rename {item.name}"
          class="mx-2 my-0.5 w-full text-[0.8rem]"
          onCommit={commitRename}
          onCancel={() => (editingId = '')}
        />
      {:else if confirmingDeleteId === item.id}
        <!-- The prompt takes over the row, so the name stays in place and
             the select button can't be hit by mistake mid-confirm. -->
        <InlineConfirmRow
          message="Delete “{item.name}”?"
          confirmLabel="Delete"
          onConfirm={() => commitDelete(item)}
          onCancel={() => (confirmingDeleteId = '')}
        />
      {:else}
        {@const shortcut = shortcutKeys[i]}
        {#if items.length > 1}
          <ReorderHandle {reorder} index={i} count={items.length} label={item.name} />
        {/if}
        <RowButton
          class="gap-2 {items.length > 1 ? 'pl-1' : 'pl-3'} pr-3 text-[0.8rem] {item.id === activeId
            ? 'text-accent'
            : ''}"
          aria-label={shortcut ? `${item.name}, Perform shortcut ${shortcut}` : item.name}
          onclick={() => select(item.id)}
        >
          {#if shortcutKeys.length > 0}
            <span class="w-4 shrink-0 text-center font-mono text-muted" aria-hidden="true"
              >{shortcut ?? ''}</span
            >
          {/if}
          <span class="min-w-0 truncate">{item.name}</span>
        </RowButton>
        <IconButton
          reveal
          tone="accent"
          label="Rename {item.name}"
          tip="Rename"
          onclick={() => beginRename(item)}
        >
          <PencilSimpleIcon size={14} />
        </IconButton>
        <IconButton
          reveal
          tone="warn"
          class="mr-1"
          label="Delete {item.name}"
          tip="Delete"
          onclick={() => (confirmingDeleteId = item.id)}
        >
          <TrashIcon size={14} />
        </IconButton>
      {/if}
    </li>
  {:else}
    <li class="px-3 py-2 text-center text-[0.8rem] text-muted">{emptyLabel}</li>
  {/each}
</ul>

<div class="border-t border-ink/10 p-1">
  {@render footerTop?.({ close })}

  <SaveAsRow
    bind:editing={saving}
    placeholder={savePlaceholder}
    inputLabel={saveInputLabel}
    disabled={!canSave}
    onSave={commitSave}
  />

  {@render footerBottom?.({ close })}
</div>
