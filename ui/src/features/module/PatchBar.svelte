<script lang="ts">
  import { CaretDownIcon, PencilSimpleIcon, TrashIcon } from 'phosphor-svelte';
  import type { Patch } from '../../lib/engine/types';
  import { knobSignature } from '../../lib/engine/knobLayout';
  import Popover from '../../lib/components/Popover.svelte';
  import InlineRenameInput from '../../lib/components/InlineRenameInput.svelte';
  import InlineConfirmRow from '../../lib/components/InlineConfirmRow.svelte';
  import SaveAsRow from '../../lib/components/SaveAsRow.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import Tone3000Logo from '../tone3000/Tone3000Logo.svelte';

  interface Props {
    /** Whether the menu is showing. Bindable so the host can keep its own
        hover-revealed chrome visible while the (portalled) menu is open. */
    open?: boolean;
    /** Saved patches available for this plugin. */
    patches: Patch[];
    /** Signature of the module's current knob layout, for the dirty check. */
    signature: string;
    /** Save the module's current layout and the plugin's tone as a new patch;
        resolves with its id once the tone has been captured. */
    onSave: (name: string) => Promise<string | null>;
    /** Recapture the module's current layout and tone into an existing patch. */
    onUpdate: (patchId: string) => Promise<void>;
    onLoad: (patchId: string) => void;
    onRename: (patchId: string, name: string) => void;
    onDelete: (patchId: string) => void;
    /** Open the TONE3000 browser for this module. Present only on modules
        hosting Neural Amp Modeler; absent leaves this menu as it was. */
    onBrowseTone3000?: () => void;
  }

  let {
    open = $bindable(false),
    patches,
    signature,
    onSave,
    onUpdate,
    onLoad,
    onRename,
    onDelete,
    onBrowseTone3000,
  }: Props = $props();

  const MENU_MAX_HEIGHT = 320; // px

  let saving = $state(false);
  // The patch currently loaded onto this module (UI-only, like RigBar's active
  // rig). Set on load/save; drives the trigger label and the dirty indicator.
  let activeId = $state('');
  // Id of the patch being renamed inline.
  let editingId = $state('');
  // Deleting a patch is unrecoverable, so the row asks first. Only ever one at
  // a time: starting a second confirm (or a rename) drops the pending one.
  let confirmingDeleteId = $state('');

  const activePatch = $derived(patches.find((p) => p.id === activeId));
  const dirty = $derived(!!activePatch && knobSignature(activePatch.knobs) !== signature);

  // Default name for a new patch, numbered like a scene. The first free number
  // rather than `length + 1`: deleting from the middle would otherwise hand out
  // a name already on the list, and every row would read the same.
  const defaultName = $derived.by(() => {
    const taken = new Set(patches.map((p) => p.name));
    let n = 1;
    while (taken.has(`Patch ${n}`)) n++;
    return `Patch ${n}`;
  });

  function resetOnOpen() {
    saving = false;
    editingId = '';
    confirmingDeleteId = '';
  }

  function load(id: string) {
    onLoad(id);
    activeId = id;
    open = false;
  }

  function beginRename(p: Patch) {
    editingId = p.id;
    confirmingDeleteId = '';
  }

  function commitRename(value: string) {
    if (value.trim()) onRename(editingId, value);
    editingId = '';
  }

  function commitDelete(p: Patch) {
    onDelete(p.id);
    if (p.id === activeId) activeId = '';
    confirmingDeleteId = '';
  }

  async function commitSave(raw: string) {
    // Enter always accepts, exactly like a scene or rig name: leaving the field
    // empty takes the placeholder (the plugin name), which is what the engine
    // would fall back to anyway.
    // Closed first: capturing the plugin's tone is a round-trip to the audio
    // side, and the menu should not sit open waiting for it.
    open = false;
    // The new patch becomes the active one; a failed save leaves none active
    // rather than pointing at whatever was loaded before.
    activeId = (await onSave(raw.trim() || defaultName)) ?? '';
  }

  function update() {
    // Keyed by id, not name: patches may share a display name, and saving one
    // must never write over another (or silently append a duplicate).
    if (!activePatch) return;
    void onUpdate(activePatch.id);
    open = false;
  }
</script>

<Popover bind:open maxHeight={MENU_MAX_HEIGHT} gap={4} panelClass="w-56" onOpen={resetOnOpen}>
  {#snippet trigger(props)}
    <button
      {...props}
      class="flex cursor-pointer items-center gap-1.5 rounded-[var(--dock-radius,6px)] border border-ink/10 bg-ink/3 px-2 py-[.35rem] text-[.7rem] text-ink [transition:all_.25s_cubic-bezier(.25,.8,.25,1)] enabled:hover:border-accent enabled:hover:bg-[color:color-mix(in_srgb,var(--color-accent)_15%,var(--color-panel))] enabled:hover:text-accent enabled:hover:shadow-[0_0_12px_color-mix(in_srgb,var(--color-accent)_25%,transparent)]"
      aria-label="Patches"
      {@attach tooltip('Save or load a knob layout and tone for this plugin')}
    >
      {#if activePatch?.tone3000}
        <Tone3000Logo variant="mark" height={9} class="shrink-0" />
      {/if}
      {#if dirty}
        <span
          class="size-1.5 shrink-0 rounded-full bg-accent"
          {@attach tooltip('Knob layout changed since this patch')}
        ></span>
      {/if}
      <span class="max-w-24 truncate {activePatch ? 'text-ink' : 'text-muted'}">
        {activePatch ? activePatch.name : 'Patch'}
      </span>
      <CaretDownIcon size={12} weight="bold" class="shrink-0" />
    </button>
  {/snippet}

  {#if onBrowseTone3000}
    <!-- Above the saved list, which is what TONE3000's entry-point requirement
         describes: the host's own tones, then a way to theirs, in the place a
         tone is chosen. The compact mark, not the full logo — by the time a
         module has a patch menu the user has met TONE3000 in the drawer. -->
    <div class="border-b border-ink/10 p-1">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-1.5 rounded px-3 py-1.5 text-left text-xs text-ink/80 hover:bg-ink/10"
        onclick={() => {
          open = false;
          onBrowseTone3000?.();
        }}
      >
        <Tone3000Logo variant="mark" height={11} />
        <span>Browse TONE3000…</span>
      </button>
    </div>
  {/if}

  <ul class="overflow-y-auto py-1" role="listbox" aria-label="Saved patches">
    {#each patches as p (p.id)}
      <li role="option" aria-selected={p.id === activeId} class="group flex items-center">
        {#if editingId === p.id}
          <InlineRenameInput
            value={p.name}
            ariaLabel="Rename {p.name}"
            class="mx-2 my-0.5 w-full rounded border border-accent/60 bg-field px-2 py-1 text-xs text-ink focus:outline-none"
            onCommit={commitRename}
            onCancel={() => (editingId = '')}
          />
        {:else if confirmingDeleteId === p.id}
          <!-- The prompt takes over the row, so the name stays in place and the
               load button can't be hit by mistake mid-confirm. -->
          <InlineConfirmRow
            dense
            message="Delete “{p.name}”?"
            confirmLabel="Delete"
            onConfirm={() => commitDelete(p)}
            onCancel={() => (confirmingDeleteId = '')}
          />
        {:else}
          <button
            type="button"
            class="flex flex-1 items-center gap-1.5 truncate px-3 py-1.5 text-left text-xs {p.id ===
            activeId
              ? 'text-accent'
              : 'text-ink/80'} hover:bg-ink/10"
            onclick={() => load(p.id)}
          >
            {#if p.tone3000}
              <!-- The compact mark, so a tone from TONE3000 is identifiable in
                   the menu the user actually switches tones from. -->
              <Tone3000Logo variant="mark" height={9} class="shrink-0" />
            {/if}
            <span class="truncate">{p.name}</span>
          </button>
          {#if p.readOnly}
            <!-- Installed with a package, so it is not the user's to rename or
                 delete — uninstalling its pack is what removes it. Loading it
                 and saving under a new name is the way to an editable copy. -->
            <span
              class="mr-2 shrink-0 rounded bg-ink/10 px-1 py-px text-[.6rem] text-muted"
              {@attach tooltip('Installed with a package')}>Pack</span
            >
          {:else}
            <button
              type="button"
              class="p-1.5 text-muted opacity-0 group-hover:opacity-100 hover:text-accent"
              aria-label="Rename {p.name}"
              {@attach tooltip('Rename')}
              onclick={() => beginRename(p)}
            >
              <PencilSimpleIcon size={13} />
            </button>
            <button
              type="button"
              class="p-1.5 pr-2 text-muted opacity-0 group-hover:opacity-100 hover:text-warn"
              aria-label="Delete {p.name}"
              {@attach tooltip('Delete')}
              onclick={() => (confirmingDeleteId = p.id)}
            >
              <TrashIcon size={13} />
            </button>
          {/if}
        {/if}
      </li>
    {:else}
      <li class="px-3 py-2 text-center text-xs text-muted">No saved patches</li>
    {/each}
  </ul>

  <div class="border-t border-ink/10 p-1">
    <!-- Offered whenever a patch is loaded, not only when the dot is showing:
         a patch also carries the plugin's own tone, which `signature` cannot
         see (it covers the mapping alone). Gating this on `dirty` would leave
         a tone tweaked in the plugin's own editor with no way to be
         re-captured. The dot means "the mapping drifted"; this button means
         "re-capture everything". -->
    {#if activePatch && !activePatch.readOnly}
      <button
        type="button"
        class="block w-full rounded px-3 py-1.5 text-left text-xs text-ink/80 hover:bg-ink/10"
        onclick={update}
      >
        Update “{activePatch.name}”
      </button>
    {/if}

    <SaveAsRow
      bind:editing={saving}
      dense
      placeholder={defaultName}
      inputLabel="Patch name"
      onSave={commitSave}
    />
  </div>
</Popover>
