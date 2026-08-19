<script lang="ts">
  import { CaretDownIcon, PencilSimpleIcon, TrashIcon } from 'phosphor-svelte';
  import type { Patch } from '../../lib/engine/types';
  import type { PatchGroup } from '../../lib/engine/drawerGroups';
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
    /** Saved patches available for this plugin, under the same headings and in
        the same hand order the drawer files them by — a patch is one thing
        wherever it is offered, so the list a module switches tones from must
        not be a second, differently sorted answer to "which patches are
        there". Sections arrive resolved (see `patchGroups`); this component
        only prints them. */
    sections: PatchGroup[];
    /** Signature of the module's current knob layout, for the dirty check. */
    signature: string;
    /** Save the module's current layout and the plugin's tone as a new patch;
        resolves with its id once the tone has been captured. */
    onSave: (name: string) => Promise<string | null>;
    /** Recapture the module's current layout and tone into an existing patch. */
    onUpdate: (patchId: string) => Promise<void>;
    onLoad: (patchId: string) => void;
    /** Show the patch the pointer is resting on: its mapping and look go onto
        the live module, so the card renders as the patch would make it. The
        sound is untouched — see the engine's `previewPatch`. Absent, the menu
        is a plain list. */
    onPreview?: (patchId: string) => void;
    /** End a preview without choosing, putting the card back as it was. */
    onCancelPreview?: () => void;
    onRename: (patchId: string, name: string) => void;
    onDelete: (patchId: string) => void;
    /** Keep this module's current knob layout as the template every newly
        downloaded TONE3000 tone starts from. Present only on modules hosting
        Neural Amp Modeler — the one plugin those tones load into — so the row
        never appears where it could not mean anything. Lives in this menu
        because it is the same gesture as saving a patch: arrange the knobs,
        then name what the arrangement is for. */
    onSetToneTemplate?: () => void;
  }

  let {
    open = $bindable(false),
    sections,
    signature,
    onSave,
    onUpdate,
    onLoad,
    onPreview,
    onCancelPreview,
    onRename,
    onDelete,
    onSetToneTemplate,
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

  /** The sections' patches as one list, for everything that is about the set
      rather than the layout: which patch is active, and the next free name. */
  const patches = $derived(sections.flatMap((s) => s.entries.map((e) => e.patch)));

  /** Headings are worth their line only once there is more than one: a single
      one names the whole list, which the trigger already did. */
  const showHeadings = $derived(sections.length > 1);

  const activePatch = $derived(patches.find((p: Patch) => p.id === activeId));
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

  // The patch the pointer is on, shown on the card ('' = none). Applied on
  // entering the row rather than after a dwell: nothing is touched but the
  // card's own rendering, exactly like the appearance menu's colour hover, so
  // there is no cost to charge a delay against.
  let previewingId = $state('');

  function resetOnOpen() {
    saving = false;
    editingId = '';
    confirmingDeleteId = '';
  }

  /** Show `id` on the card. Rows in an editor of their own are skipped: a row
      being renamed or confirming a delete is not offering to be tried on. */
  function preview(id: string) {
    if (!onPreview || previewingId === id || editingId === id || confirmingDeleteId === id) return;
    previewingId = id;
    onPreview(id);
  }

  /** Leave the run: put the card back as it was, if anything was applied. */
  function endPreview() {
    if (!previewingId) return;
    previewingId = '';
    onCancelPreview?.();
  }

  function load(id: string) {
    // The preview is the choice, so it is kept rather than undone: the engine
    // drops the run on the load, and forgetting the id here keeps the panel's
    // unmount (below) from asking for a revert the engine would refuse anyway.
    previewingId = '';
    onLoad(id);
    activeId = id;
    open = false;
  }

  function beginRename(p: Patch) {
    // Editing a row is not trying it on: end the preview rather than leave the
    // card wearing something the user is only relabelling.
    endPreview();
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
    // A capture reads the module, so any preview still applied must be put
    // back first — reaching Save with the pointer ends it on the way, but a
    // keyboard focus starts a preview nothing else ends. The engine settles it
    // again on its side; this also keeps the row highlight honest.
    endPreview();
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
    endPreview(); // same reasoning as commitSave — never recapture a try-on
    void onUpdate(activePatch.id);
    open = false;
  }
</script>

<Popover bind:open maxHeight={MENU_MAX_HEIGHT} gap={4} panelClass="w-56" onOpen={resetOnOpen}>
  {#snippet trigger(props)}
    <button
      {...props}
      class="patch-trigger flex cursor-pointer items-center gap-1.5 rounded-[var(--dock-radius,6px)] border border-ink/10 bg-ink/3 px-2 py-[.35rem] text-[.7rem] text-ink [transition:all_.25s_cubic-bezier(.25,.8,.25,1)] enabled:hover:border-accent enabled:hover:bg-[color:color-mix(in_srgb,var(--color-accent)_15%,var(--color-panel))] enabled:hover:text-accent enabled:hover:shadow-[0_0_12px_color-mix(in_srgb,var(--color-accent)_25%,transparent)]"
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

  <!-- The whole list ends the run, not each row: moving from one row to the
       next hands the preview straight over, and only leaving the list (or
       closing the panel, which unmounts this and runs the attachment's
       cleanup) means "never mind". -->
  <!-- No top padding while headings are showing: the first heading is sticky,
       and a padded strip above it is scrollport the rows slide up into, so a
       sliver of the row underneath shows above the heading pinned over it. -->
  <ul
    class="overflow-y-auto pb-1 {showHeadings ? '' : 'pt-1'}"
    role="listbox"
    aria-label="Saved patches"
    onpointerleave={endPreview}
    {@attach () => endPreview}
  >
    {#each sections as section (section.key)}
      {#if showHeadings}
        <!-- Sticky, because the list is a fixed-height scroller and a heading
             scrolled past leaves the rows under it unattributed. The panel's
             own colour, opaque: rows pass underneath it. -->
        <li
          role="presentation"
          class="sticky top-0 z-10 truncate bg-menu px-3 py-1.5 text-[.6rem] font-semibold tracking-wide text-muted uppercase"
        >
          {section.label}
        </li>
      {/if}
      {#each section.entries as { patch: p } (p.id)}
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
              class:previewing={p.id === previewingId}
              onclick={() => load(p.id)}
              onpointerenter={() => preview(p.id)}
              onfocus={() => preview(p.id)}
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
                {@attach tooltip(
                  p.devSource
                    ? 'Installed with a package — the repo has its sources, so it can be re-saved'
                    : 'Installed with a package',
                )}>Pack</span
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
                onclick={() => {
                  endPreview(); // same reasoning as beginRename
                  confirmingDeleteId = p.id;
                }}
              >
                <TrashIcon size={13} />
              </button>
            {/if}
          {/if}
        </li>
      {/each}
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
    <!-- A pack patch is the one exception, and only where this machine carries
         the sources it was built from (`devSource`): the write goes to those
         sources in the repo, never to the installed copy, so re-saving one is
         authoring it rather than editing somebody's installation. Says so on
         the row — the same click means two different things. -->
    {#if activePatch && (!activePatch.readOnly || activePatch.devSource)}
      <button
        type="button"
        class="block w-full rounded px-3 py-1.5 text-left text-xs text-ink/80 hover:bg-ink/10"
        onclick={update}
        {@attach activePatch.devSource
          ? tooltip('Writes packaging/content in the repo, not the installed pack')
          : () => {}}
      >
        Update {activePatch.devSource ? 'pack source ' : ''}“{activePatch.name}”
      </button>
    {/if}

    <SaveAsRow
      bind:editing={saving}
      dense
      placeholder={defaultName}
      inputLabel="Patch name"
      onSave={commitSave}
    />

    {#if onSetToneTemplate}
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded px-3 py-1.5 text-left text-xs text-ink/80 hover:bg-ink/10"
        onclick={() => {
          // The template is captured from the module's params on the page
          // side, so the preview must be settled before the callback reads
          // them — the engine's own guard never sees this path.
          endPreview();
          onSetToneTemplate();
          open = false;
        }}
        {@attach tooltip('New tones from TONE3000 will arrive with this knob layout')}
      >
        <Tone3000Logo variant="mark" height={9} class="shrink-0" />
        Set as tone template
      </button>
    {/if}
  </div>
</Popover>

<style>
  /* The row being previewed. Deliberately more than the hover background it
     sits on: that one says "the pointer is here", while this has to answer the
     question the card is now raising — why it just changed, and what it will
     change back to. */
  .previewing {
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    box-shadow: inset 2px 0 0 var(--color-accent);
  }
</style>
