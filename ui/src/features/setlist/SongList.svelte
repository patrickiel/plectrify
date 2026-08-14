<script lang="ts">
  import { fade, slide } from 'svelte/transition';
  import { PencilSimpleIcon, WarningIcon, XIcon } from 'phosphor-svelte';
  import type { AppSettings, Rig, SceneState, Song } from '../../lib/engine/types';
  import { uid } from '../../lib/engine/ids';
  import {
    addSong,
    addableSongs,
    addToSetlist,
    captureSong,
    deleteSong,
    findSetlist,
    moveSong,
    moveSongInSetlist,
    playOrder,
    removeFromSetlist,
    songHealth,
    updateSong,
  } from '../../lib/engine/songs';
  import IconButton from '../../lib/components/IconButton.svelte';
  import RowButton from '../../lib/components/RowButton.svelte';
  import ReorderHandle from '../../lib/components/ReorderHandle.svelte';
  import SaveAsRow from '../../lib/components/SaveAsRow.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import { VerticalReorder } from '../../lib/components/verticalReorder.svelte';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import SongEditor from './SongEditor.svelte';

  /**
   * The running order — and there is only ever one.
   *
   * This list *is* `playOrder`, so what the player is looking at is exactly
   * what Prev and Next walk. The panel used to keep a library tab and a setlist
   * tab side by side, which let the two disagree: you could be reading the book
   * while the transport walked Friday's set. The source picker above chooses
   * between them instead, and everything below follows it.
   *
   * A setlist holds only ids, so editing a song here is editing it everywhere
   * it appears — that is why there is no separate "library" place to edit from.
   */
  interface Props {
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    rigs: Rig[];
    sceneState: SceneState;
    /** Locked while the engine is loading a rack — recalling twice mid-load
        would only be dropped by the engine anyway, and a dead button is
        clearer than a silent one. */
    busy: boolean;
    /** Perform hides everything that changes the book — reorder, the editor,
        add and remove — leaving only the rows a player calls songs from. */
    editMode: boolean;
    onRecall: (song: Song) => void;
  }

  let { appSettings, onSetAppSettings, rigs, sceneState, busy, editMode, onRecall }: Props =
    $props();

  // Motion for what Edit reveals — see reveal.svelte.ts.
  const reveal = createReveal();

  const activeSetlist = $derived(findSetlist(appSettings));
  const rows = $derived(playOrder(appSettings));
  // The source decides what a drag means: with a set up it reorders tonight's
  // running order, without one it reorders the book itself.
  const reorder = new VerticalReorder((from, to) => {
    const moved = rows[from];
    if (!moved) return;
    if (activeSetlist)
      onSetAppSettings({
        setlists: moveSongInSetlist(appSettings.setlists, activeSetlist.id, moved.id, to),
      });
    else onSetAppSettings({ songs: moveSong(appSettings.songs, moved.id, to) });
  });

  let saving = $state(false);
  /** Narrows the add-from pool. Session-only and never persisted: it is a way
      of reaching one song, not a setting. */
  let poolFilter = $state('');
  /** The pool you add from: A–Z, minus what is already in the set, minus what
      the filter rules out. `poolCount` is the unfiltered size, so the header
      keeps counting what is out there while you type. */
  const pool = $derived(addableSongs(appSettings.songs, activeSetlist, poolFilter));
  const poolCount = $derived(addableSongs(appSettings.songs, activeSetlist).length);
  /** The one row with its editor open. One id for one idea: the old panel kept
      a separate `editingId` for renaming and `expandedId` for recall targets,
      which is exactly the split this editor collapses. */
  let editingId = $state('');

  /** Never falls back to the raw id — while rigs are still loading (or the
      rig is gone) a UUID is noise, so an unresolvable target shows a neutral
      "rig" label and lets the warning chip carry the message. */
  function rigName(id: string | undefined): string | null {
    if (id === undefined) return null;
    return rigs.find((rig) => rig.id === id)?.name ?? 'rig';
  }

  /** A song's scene name, or null when there is nothing to show. Only the
      loaded rig's scenes are in hand, so a song pointing into another rig —
      or a scene that cannot be resolved — shows a neutral "scene" chip
      rather than a raw id. */
  function sceneLabel(song: Song): string | null {
    if (song.sceneId === undefined) return null;
    if ((song.rigId ?? appSettings.activeRigId) !== appSettings.activeRigId) return 'scene';
    return sceneState.scenes.find((scene) => scene.id === song.sceneId)?.name ?? 'scene';
  }

  function patch(song: Song, fields: Partial<Omit<Song, 'id'>>) {
    onSetAppSettings({ songs: updateSong(appSettings.songs, song.id, fields) });
  }

  function commitDelete(song: Song) {
    onSetAppSettings(deleteSong(appSettings.songs, appSettings.setlists, song.id));
    if (editingId === song.id) editingId = '';
  }

  /** "Add the current sound" — a new song already pointing at the loaded rig
      and scene, which is how a song normally comes into being: you dialled the
      sound in, now you name it. With a set up it lands in that set too, because
      the set is what you are looking at. */
  function addCurrent(name: string) {
    const song = captureSong(uid('song'), name.trim() || `Song ${appSettings.songs.length + 1}`, {
      activeRigId: appSettings.activeRigId,
      activeSceneId: sceneState.activeSceneId,
    });
    onSetAppSettings(
      addSong(appSettings.songs, appSettings.setlists, appSettings.activeSetlistId, song),
    );
    // Unlike the rig/patch menus this row is modelled on, nothing closes
    // around it here — the panel stays open — so the input has to put itself
    // away, or the next song would be typed over the last one's name.
    saving = false;
    editingId = song.id;
  }

  /** The scrolling box the running order sits in — the nearest ancestor that
      actually has somewhere to scroll. Found by walking up rather than named,
      because the box belongs to whoever mounts this list (the tool panel docks
      it and the stage view maximizes it), not to the list. */
  function scrollBox(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const overflow = getComputedStyle(p).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight)
        return p;
    }
    return null;
  }

  /** Keeps the running song on screen. A set is longer than the panel, so by
      the third or fourth song a foot press moves a row nobody can see — the
      list has to follow the transport, not the other way round.

      The song goes to the *top* of the box, not merely into view: what a player
      needs mid-set is the rest of the night below the line they are on, so the
      space under the current song is the useful space. At the end of a set
      there is nothing left to scroll and the last rows simply sit where they
      are — the clamp does that for free, so the run-out needs no special case.

      Scrolling the box rather than calling `scrollIntoView` keeps the move
      local: a top-aligning `scrollIntoView` would also walk every scrollable
      ancestor, which on the stage view means the rack behind the panel.
      Reading `activeSongId` here is what re-runs the attachment on every
      change of song. */
  function followActive(el: HTMLElement, songId: string) {
    if (songId !== appSettings.activeSongId) return;
    const box = scrollBox(el);
    if (!box) return;
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({ top, behavior: 'smooth' });
  }

  const chipClass =
    'inline-flex max-w-44 items-center gap-[.18rem] overflow-hidden rounded-sm px-[.28rem] py-[.02rem] font-mono text-[.62rem] leading-normal font-medium text-ellipsis whitespace-nowrap';
  // Accent in this panel means one thing — "you are here". A chip is a label,
  // so both the rig and the scene wear the same neutral ink; only a broken
  // target earns a colour, and that colour is the warning.
  const chipRestClass =
    'bg-[color-mix(in_srgb,var(--color-ink)_8%,transparent)] text-[color-mix(in_srgb,var(--color-ink)_58%,transparent)]';
  const chipWarnClass = 'bg-[color-mix(in_srgb,var(--color-warn)_14%,transparent)] text-warn';
  const dividerClass =
    'border-t border-[color-mix(in_srgb,var(--color-ink)_calc(8%*var(--ink-k)),transparent)]';
</script>

<ul
  class={['flex flex-col py-[.2rem]', reorder.listClass]}
  aria-label={activeSetlist ? `${activeSetlist.name} running order` : 'All songs'}
  {...reorder.listAttrs}
>
  {#each rows as song, i (song.id)}
    {@const health = songHealth(song, rigs, sceneState.scenes, appSettings.activeRigId)}
    {@const scene = sceneLabel(song)}
    {@const isActive = song.id === appSettings.activeSongId}
    <li
      class={[
        'relative rounded-control-sm',
        isActive && 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
        reorder.itemClass(i),
      ]}
      {...reorder.itemAttrs(i)}
      {@attach (el) => followActive(el, song.id)}
    >
      <div class="flex items-center hover:[--row-reveal:1]">
        {#if editMode && rows.length > 1}
          <!-- The row's height is the same in both modes, so the edit affordances
               fade in and out of it rather than sliding. -->
          <div class="flex items-center" transition:fade={reveal.fade()}>
            <ReorderHandle {reorder} index={i} count={rows.length} label={song.name} />
          </div>
        {/if}
        <!-- The position, in both source modes: it is what "2 / 11" counts and
             what a foot press steps through. -->
        <span
          class="w-[1.3rem] flex-none text-right font-mono text-[.68rem] leading-normal font-semibold text-muted tabular-nums"
          aria-hidden="true">{i + 1}</span
        >
        <RowButton
          layout="stack"
          dense
          disabled={busy}
          aria-current={isActive}
          tip="Go to this song"
          onclick={() => onRecall(song)}
        >
          <span
            class={[
              'max-w-full overflow-hidden font-sans text-[.8rem] leading-normal font-[550] text-ellipsis whitespace-nowrap',
              isActive
                ? 'text-accent'
                : 'text-[color-mix(in_srgb,var(--color-ink)_88%,transparent)]',
            ]}>{song.name}</span
          >
          <span class="flex min-w-0 flex-wrap items-center gap-1">
            {#if rigName(song.rigId)}
              <span class={[chipClass, health.rigMissing ? chipWarnClass : chipRestClass]}>
                {#if health.rigMissing}<WarningIcon size={10} aria-hidden="true" />{/if}
                {rigName(song.rigId)}
              </span>
            {/if}
            {#if scene}
              <span class={[chipClass, health.sceneMissing ? chipWarnClass : chipRestClass]}>
                {#if health.sceneMissing}<WarningIcon size={10} aria-hidden="true" />{/if}
                {scene}
              </span>
            {/if}
          </span>
        </RowButton>
        {#if editMode}
          <div class="flex items-center" transition:fade={reveal.fade()}>
            <IconButton
              reveal
              label="Edit {song.name}"
              tip="Edit"
              aria-expanded={editingId === song.id}
              onclick={() => (editingId = editingId === song.id ? '' : song.id)}
            >
              <PencilSimpleIcon size={14} />
            </IconButton>
            {#if activeSetlist}
              <IconButton
                reveal
                tone="warn"
                label="Remove {song.name} from {activeSetlist.name}"
                tip="Remove from this setlist — the song stays in the library"
                onclick={() =>
                  onSetAppSettings({
                    setlists: removeFromSetlist(appSettings.setlists, activeSetlist.id, song.id),
                  })}
              >
                <XIcon size={13} />
              </IconButton>
            {/if}
          </div>
        {/if}
      </div>

      {#if editMode && editingId === song.id}
        <!-- The editor pushes every row below it down, so it slides open. -->
        <div transition:slide={reveal.slide()}>
          <SongEditor
            {song}
            {rigs}
            {sceneState}
            activeRigId={appSettings.activeRigId}
            onPatch={(fields) => patch(song, fields)}
            onDelete={() => commitDelete(song)}
          />
        </div>
      {/if}
    </li>
  {:else}
    <!-- Three distinct nothings: an empty book, a set nobody has filled yet,
         and either of those seen from Perform, where the fix is a switch away. -->
    <li class="px-3 py-4 text-center font-sans text-[.72rem] leading-[1.45] font-medium text-muted">
      {#if !editMode}
        {activeSetlist
          ? 'This set is empty. Switch to Edit to fill it.'
          : 'No songs yet. Switch to Edit to add one.'}
      {:else}
        {activeSetlist
          ? 'This set is empty. Add songs below.'
          : 'No songs yet. Add the current sound below.'}
      {/if}
    </li>
  {/each}
</ul>

{#if editMode}
  <!-- Everything Edit adds below the running order arrives as one block, so it
       opens and closes as one motion. -->
  <div transition:slide={reveal.slide()}>
    {#if activeSetlist && poolCount > 0}
      <div class="{dividerClass} px-[.3rem] pt-[.4rem] pb-[.3rem]">
        <div class="mb-1 flex items-center gap-[.4rem] pr-[.15rem] pl-[.45rem]">
          <h3
            class="m-0 flex-none font-mono text-[.625rem] leading-normal font-semibold tracking-[.14em] text-muted uppercase"
          >
            Add to this set
          </h3>
          <!-- A pool you search by name, not a sequence you read positionally —
             so it is filtered and A–Z rather than in library order. -->
          {#if poolCount > 6}
            <TextField
              size="sm"
              class="ml-auto min-w-0 flex-1"
              bind:value={poolFilter}
              placeholder="Filter songs…"
              aria-label="Filter the songs you can add"
            />
          {/if}
        </div>
        <!-- Rows, not a wall of chips: the same rhythm as the running order above
           it, so the eye reads one list of songs in two states rather than two
           unrelated blocks. -->
        <ul class="flex flex-col" aria-label="Add to {activeSetlist.name}">
          {#each pool as song (song.id)}
            <!-- The row is the button. A ＋ on the end would be a second control
               for the click the whole row already takes. -->
            <li class="flex items-center rounded-control-sm">
              <RowButton
                dense
                aria-label="Add {song.name} to {activeSetlist.name}"
                tip="Add to {activeSetlist.name}"
                onclick={() =>
                  onSetAppSettings({
                    setlists: addToSetlist(appSettings.setlists, activeSetlist.id, song.id),
                  })}
              >
                <span
                  class="min-w-0 overflow-hidden font-sans text-[.75rem] leading-normal font-medium text-ellipsis whitespace-nowrap text-[color-mix(in_srgb,var(--color-ink)_72%,transparent)]"
                  >{song.name}</span
                >
              </RowButton>
            </li>
          {:else}
            <li class="px-2 py-[.3rem] font-sans text-[.68rem] font-medium text-muted">
              No match for “{poolFilter.trim()}”.
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="{dividerClass} px-[.15rem] py-1">
      <SaveAsRow
        bind:editing={saving}
        label="Add the current sound…"
        placeholder="Song name"
        inputLabel="Song name"
        dense
        onSave={addCurrent}
      />
    </div>
  </div>
{/if}
