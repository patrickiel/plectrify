<script lang="ts">
  import { FilePlusIcon } from 'phosphor-svelte';
  import type { Rig } from '../../lib/engine/types';
  import { nextRigName } from '../../lib/engine/rigNames';
  import SwitcherGroup from '../../lib/components/SwitcherGroup.svelte';
  import ItemMenuPanel from '../../lib/components/ItemMenuPanel.svelte';
  import InlineConfirmRow from '../../lib/components/InlineConfirmRow.svelte';
  import { RIG_SHORTCUT_KEYS } from './shortcutKeys';

  interface Props {
    rigs: Rig[];
    /** The saved rig currently loaded, if any — its segment lights up. */
    activeRig: Rig | undefined;
    /** Edit mode keeps the caret and puts the management menu behind it. */
    editMode: boolean;
    /** Whether there's anything worth saving (empty rack → nothing to save). */
    canSave: boolean;
    /** Save the current chain as a new rig under this name. */
    onSave: (name: string) => void;
    onLoad: (rigId: string) => void;
    onRename: (rigId: string, name: string) => void;
    onDelete: (rigId: string) => void;
    /** Reorder the saved-rigs list — drives the segments and the menu. */
    onMove: (rigId: string, toIndex: number) => void;
    /** Discard the whole chain and start a fresh empty rig, saved under the
        next free default name and active immediately. */
    onNew: () => void;
    /** The loaded rig has unsaved changes — shows a dot on its segment. */
    dirty?: boolean;
    /** Width budget from the toolbar half hosting this group (see TopToolbar). */
    maxWidth?: number;
    /** False while a rack-level state must block performance navigation. */
    shortcutsEnabled: boolean;
  }

  let {
    rigs,
    activeRig,
    editMode,
    canSave,
    onSave,
    onLoad,
    onRename,
    onDelete,
    onMove,
    onNew,
    dirty = false,
    maxWidth = 0,
    shortcutsEnabled,
  }: Props = $props();

  // "New rig" is destructive, so it has to be confirmed when there is
  // something to lose. That is a non-empty rack that isn't already on disk:
  // either it has drifted from the rig it was loaded from, or it was never
  // saved as a rig at all. A clean rack backed by a saved rig loses nothing —
  // it is one click away in this same list — so it skips the prompt rather
  // than asking about changes that don't exist.
  let confirmingNew = $state(false);

  function beginNew(close: () => void) {
    if (canSave && (dirty || !activeRig)) confirmingNew = true;
    else commitNew(close);
  }

  function commitNew(close: () => void) {
    onNew();
    close();
  }
</script>

<SwitcherGroup
  items={rigs}
  activeId={activeRig?.id ?? null}
  {editMode}
  {maxWidth}
  tag="Rig"
  groupLabel="Rigs"
  noneLabel="No rig"
  menuLabel="Manage rigs"
  moreLabel="More rigs"
  {dirty}
  shortcutKeys={RIG_SHORTCUT_KEYS}
  {shortcutsEnabled}
  onSelect={onLoad}
  onMenuOpen={() => (confirmingNew = false)}
>
  {#snippet menu(close)}
    <ItemMenuPanel
      items={rigs}
      activeId={activeRig?.id ?? null}
      listLabel="Saved rigs"
      emptyLabel="No saved rigs"
      savePlaceholder={nextRigName(rigs.map((r) => r.name))}
      saveInputLabel="Rig name"
      {canSave}
      shortcutKeys={RIG_SHORTCUT_KEYS}
      onSelect={onLoad}
      {onSave}
      {onRename}
      {onDelete}
      {onMove}
      {close}
    >
      {#snippet footerTop({ close })}
        {#if confirmingNew}
          <InlineConfirmRow
            stacked
            message="Discard unsaved changes?"
            confirmLabel="Discard"
            onConfirm={() => commitNew(close)}
            onCancel={() => (confirmingNew = false)}
          />
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded px-3 py-1.5 text-left text-[0.8rem] text-ink/80 hover:bg-ink/10"
            onclick={() => beginNew(close)}
          >
            <FilePlusIcon size={13} />
            New rig
          </button>
        {/if}
      {/snippet}
    </ItemMenuPanel>
  {/snippet}
</SwitcherGroup>
