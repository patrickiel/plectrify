<script lang="ts">
  import { fade, slide } from 'svelte/transition';
  import { CaretLeftIcon, CaretRightIcon, PencilSimpleIcon } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppSettings, MidiActionId, Rig, SceneState, Song } from '../../lib/engine/types';
  import { uid } from '../../lib/engine/ids';
  import {
    addSong,
    captureSong,
    createSetlist,
    deleteSetlist,
    findSetlist,
    playOrder,
    renameSetlist,
    stepSong,
  } from '../../lib/engine/songs';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import IconButton from '../../lib/components/IconButton.svelte';
  import InlineConfirmRow from '../../lib/components/InlineConfirmRow.svelte';
  import SaveAsRow from '../../lib/components/SaveAsRow.svelte';
  import Select from '../../lib/components/Select.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import MidiLearn, { type MidiLearnApi } from '../../lib/components/MidiLearn.svelte';
  import { learnStateOf } from '../../lib/components/learnSkin';
  import { onEnterEscape } from '../../lib/components/textInputBehaviors';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import SongList from './SongList.svelte';

  /**
   * The song tool: a library of songs, each recalling a rig and a scene, plus
   * optional named setlists that order them.
   *
   * Top to bottom the panel is one sentence — where you are, how to move, and
   * what you are moving through. The source picker is the hinge: it sets
   * `activeSetlistId`, which is what `playOrder` walks, so the list underneath
   * can only ever be the thing the transport steps through. An earlier draft
   * put a Songs/Setlists tab there instead, which let the two disagree.
   *
   * Advancing is not done here: the panel is unmounted whenever the sidebar is
   * collapsed, so the pedal's dispatch and the recall itself live in Rack,
   * which also owns the rig-load path. This card only asks.
   */
  interface Props {
    engine: EngineBridge;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    rigs: Rig[];
    sceneState: SceneState;
    /** True while the engine is rebuilding a rack; the transport locks. */
    busy: boolean;
    /** Recall a song — Rack's `recallSong`, routed through App. */
    onRecallSong: (song: Song) => void;
    /** True while this card's MIDI learn is armed. Bindable so App can pause
        the rack's live dispatch during a learn. */
    midiLearning?: boolean;
    /** True while a MIDI learn elsewhere is armed; this Learn won't arm a second. */
    otherLearnActive?: boolean;
    /** Stage-view layout: readable from standing distance. */
    large?: boolean;
    /** Hands this card's learn API to the panel header, whose Maximize button
        is one of the actions mapped here. */
    onLearnApi?: (api: MidiLearnApi<SongMidiAction>) => void;
  }

  let {
    engine,
    appSettings,
    onSetAppSettings,
    rigs,
    sceneState,
    busy,
    onRecallSong,
    midiLearning = $bindable(false),
    otherLearnActive = false,
    large = false,
    onLearnApi,
  }: Props = $props();

  // songMaximize's button lives in the panel header; the header borrows this
  // card's learn API (onLearnApi) so it maps like the transport below it.
  type SongMidiAction = Extract<MidiActionId, 'songNext' | 'songPrev' | 'songMaximize'>;
  const SONG_ACTIONS: SongMidiAction[] = ['songPrev', 'songNext', 'songMaximize'];

  /** Maximized is the stage view: it is always Perform, whatever the sidebar
      was left on. The header drops the Perform/Edit switch to match.
   *
   * This also gates the MIDI learn switch (`showControl`), the way Simple does
   * for the looper and metronome: mapping a pedal is setup, and Perform is the
   * mode with nothing in it that a stray press can change. Hiding it ends an
   * active learn, so leaving Edit mid-map puts the transport straight back to
   * moving through the set. */
  const editMode = $derived(!large && appSettings.songEditMode);
  // Motion for what Edit reveals — see reveal.svelte.ts.
  const reveal = createReveal();

  // One height for every control in the panel, and the same one the metronome
  // uses for its play bar — a tool panel should not have its own scale.
  const controlRowHeight = $derived(large ? 'h-14' : 'h-12');

  /** On the stage the column is wide enough for a real song title at 2.6rem —
      "Couldn't Stand the Weather" is the length a set actually holds, and a
      name ending in an ellipsis is the one thing the now-playing card must
      never do. Only the card spends that width: a transport button and a song
      row gain nothing from it, so everything below wears this class and keeps
      the narrower measure it reads best at. */
  const stageColumn = $derived(large ? 'mx-auto w-full max-w-136' : '');

  const order = $derived(playOrder(appSettings));
  const activeSetlist = $derived(findSetlist(appSettings));
  const currentIndex = $derived(order.findIndex((song) => song.id === appSettings.activeSongId));
  const current = $derived(currentIndex >= 0 ? order[currentIndex] : null);
  const prevSong = $derived(stepSong(order, appSettings.activeSongId, -1));
  const nextSong = $derived(stepSong(order, appSettings.activeSongId, 1));

  /** How far through the set the current song sits, for the card's progress
      bar. Zero both for an empty order and for "Not started" — the bar only
      fills once the set is actually moving. */
  const setProgress = $derived(
    order.length > 0 && currentIndex >= 0 ? (currentIndex + 1) / order.length : 0,
  );

  /** "All songs" is a real choice, not an empty state: it means next/prev walks
      the whole library, which is how a player who calls songs on the night uses
      this tool. */
  const sourceOptions = $derived([
    { value: '', label: 'All songs' },
    ...appSettings.setlists.map((list) => ({ value: list.id, label: list.name })),
  ]);

  /** True until anything exists to perform with. The panel is a transport, and
      a transport over nothing is a wall of dead controls — so the first-run
      state replaces all of it with one sentence and one button, and the real
      panel only appears once there is something for it to walk. */
  const libraryEmpty = $derived(appSettings.songs.length === 0);

  /** Whether the first-run button has swapped into its name input. */
  let namingFirstSong = $state(false);
  let firstSongName = $state('');
  let firstSongInput: HTMLInputElement | undefined = $state();

  /** The same capture SongList's "Add the current sound…" does — the loaded
      rig and scene under a name — but from the first-run state, where the
      list (and its add row) is not on screen yet. The new song becomes the
      current one directly rather than through a recall: it *is* the live
      sound, so there is nothing to load. */
  function addFirstSong(name: string) {
    const song = captureSong(uid('song'), name.trim() || 'Song 1', {
      activeRigId: appSettings.activeRigId,
      activeSceneId: sceneState.activeSceneId,
    });
    onSetAppSettings({
      ...addSong(appSettings.songs, appSettings.setlists, '', song),
      activeSongId: song.id,
    });
    namingFirstSong = false;
  }

  /** Whether the setlist editor is showing. Session-only: it is a setup panel,
      and reopening the tool mid-set should land on the running order. */
  let setlistEditorOpen = $state(false);
  let creating = $state(false);
  let confirmingDelete = $state(false);
  let atSetlistCap = $state(false);

  function go(song: Song | null) {
    if (song && !busy) onRecallSong(song);
  }

  function selectSource(id: string) {
    confirmingDelete = false;
    onSetAppSettings({ activeSetlistId: id });
  }

  function commitSetlistName(value: string, input: HTMLInputElement) {
    const name = value.trim();
    if (!activeSetlist) return;
    if (name)
      onSetAppSettings({ setlists: renameSetlist(appSettings.setlists, activeSetlist.id, name) });
    else input.value = activeSetlist.name;
  }

  /** True when a set was actually made, so the picker knows whether to close.
      At the cap it stays open holding the name typed, with the reason under it —
      dismissing the menu there would look like it had worked. */
  function commitCreate(name: string): boolean {
    const next = createSetlist(
      appSettings.setlists,
      uid('setlist'),
      name.trim() || `Set ${appSettings.setlists.length + 1}`,
    );
    if (!next) {
      atSetlistCap = true;
      return false;
    }
    // Selecting the new set is the point: you made it to fill it, and the list
    // below switches to it the moment the menu closes.
    onSetAppSettings({ setlists: next, activeSetlistId: next[next.length - 1].id });
    creating = false;
    atSetlistCap = false;
    setlistEditorOpen = false;
    return true;
  }

  /** Deleting a set drops only the running order; every song stays in the
      library, which is the whole reason the two levels are separate. */
  function commitDelete() {
    if (!activeSetlist) return;
    onSetAppSettings({
      setlists: deleteSetlist(appSettings.setlists, activeSetlist.id),
      activeSetlistId: '',
    });
    confirmingDelete = false;
  }
</script>

<section
  class={[
    'flex h-full flex-col gap-2 px-[.6rem] pt-2 pb-[.6rem]',
    large && 'mx-auto w-full max-w-208 gap-[.8rem] px-[1.2rem] pt-[1.1rem] pb-6',
  ]}
  aria-label="Songs"
>
  <MidiLearn
    {engine}
    {appSettings}
    {onSetAppSettings}
    {otherLearnActive}
    {large}
    actions={SONG_ACTIONS}
    showControl={editMode && !libraryEmpty}
    onApi={onLearnApi}
    bind:active={midiLearning}
    startTip="Map your MIDI pedal: click a transport button, then press its switch"
  >
    {#snippet children(learn)}
      {#if libraryEmpty}
        <!-- First run: no dashboard over nothing. One sentence saying what a
             song is, and the one action that gets you your first — the same
             capture the list's add row does, without asking anyone to find
             Edit mode first. -->
        <div
          class={[
            'flex flex-1 flex-col items-center justify-center gap-[.55rem] px-4 pb-10 text-center',
            large && 'gap-[.9rem]',
            stageColumn,
          ]}
        >
          <h3
            class={[
              'm-0 font-sans text-[.95rem] leading-tight font-[650] text-ink',
              large && 'text-[1.8rem]',
            ]}
          >
            No songs yet
          </h3>
          <p
            class={[
              'm-0 max-w-64 font-sans text-[.74rem] leading-[1.5] font-medium text-muted',
              large && 'max-w-120 text-[1.05rem]',
            ]}
          >
            A song recalls a rig and scene with one press. Save the sound you have loaded now as
            your first one, then step through your set with Prev and Next.
          </p>
          {#if namingFirstSong}
            <TextField
              bind:element={firstSongInput}
              bind:value={firstSongName}
              size="md"
              class="mt-[.2rem] w-full max-w-64"
              placeholder="Song name"
              aria-label="Song name"
              onkeydown={onEnterEscape(
                () => addFirstSong(firstSongName),
                () => (namingFirstSong = false),
              )}
            />
          {:else}
            <Button
              tone="accent"
              size={large ? 'lg' : 'md'}
              class="mt-[.2rem]"
              tip="Save the loaded rig and scene as a song"
              onclick={() => {
                namingFirstSong = true;
                firstSongName = '';
                queueMicrotask(() => firstSongInput?.focus({ preventScroll: true }));
              }}
            >
              Save current sound as a song
            </Button>
          {/if}
        </div>
      {:else}
        <!-- What the player reads between songs: where they are, and what the
           next press brings. The name is the biggest thing on the card. The
           source is not repeated here — the picker below the transport says
           it, and saying it twice was half of why the panel read as busy. -->
        <Card
          class={[
            'flex-none px-[.6rem] pt-[.55rem] pb-[.55rem]',
            large && 'px-[1.1rem] pt-4 pb-[.9rem]',
          ]}
          role="status"
        >
          <!-- Where we are in the set, said twice in one row: the count gives
             the number, the bar gives the shape of the night at a glance. -->
          <div class={['flex items-center gap-[.55rem]', large && 'gap-[.7rem]']}>
            <span
              class={[
                'flex-none font-mono text-[.72rem] leading-normal font-[650] tracking-[.04em] tabular-nums',
                large && 'text-[1.05rem]',
              ]}
            >
              {#if order.length === 0}
                <span class="text-[color-mix(in_srgb,var(--color-ink)_38%,transparent)]">—</span>
              {:else}
                <span class="text-[color-mix(in_srgb,var(--color-ink)_82%,transparent)]"
                  >{currentIndex >= 0 ? currentIndex + 1 : '–'}</span
                ><span class="text-[color-mix(in_srgb,var(--color-ink)_40%,transparent)]">
                  / {order.length}</span
                >
              {/if}
            </span>
            <div
              class={[
                'h-[.18rem] flex-1 overflow-hidden rounded-full bg-ink/10',
                large && 'h-[.32rem]',
              ]}
              aria-hidden="true"
            >
              <div
                class="h-full rounded-full bg-accent shadow-(--shadow-glow-accent-bar) transition-[width] duration-300"
                style:width="{setProgress * 100}%"
              ></div>
            </div>
          </div>
          <!-- Three distinct nothings, and they mean different things: an empty
             library, a set with nothing in it yet, and a set not started. -->
          <span
            class={[
              'mt-[.35rem] overflow-hidden font-sans text-[1.05rem] leading-tight font-[650] text-ellipsis whitespace-nowrap text-ink',
              !current && 'font-medium text-[color-mix(in_srgb,var(--color-ink)_40%,transparent)]',
              large && 'mt-[.55rem] text-[2.6rem]',
            ]}
          >
            {current
              ? current.name
              : order.length > 0
                ? 'Not started'
                : activeSetlist
                  ? 'Empty setlist'
                  : 'No songs yet'}
          </span>
          <!-- The note and the Next row always occupy their line, empty or not.
             Every line here is single-line and ellipsised, so holding all of
             them makes the card one fixed height without a hard-coded one —
             and the transport under it stops moving as you walk a set where
             only some songs carry a note. -->
          <span
            class={[
              'overflow-hidden font-sans text-[.74rem] leading-normal font-medium text-ellipsis whitespace-nowrap text-[color-mix(in_srgb,var(--color-ink)_62%,transparent)]',
              large && 'text-[1.1rem]',
            ]}
            >{#if current?.notes}{current.notes}{:else}&nbsp;{/if}</span
          >
          <div
            class={['mt-[.4rem] flex min-w-0 items-baseline gap-[.45rem]', large && 'mt-[.55rem]']}
          >
            {#if nextSong && nextSong.id !== current?.id}
              <span
                class={[
                  'flex-none font-mono text-[.6rem] leading-normal font-semibold tracking-[.09em] text-[color-mix(in_srgb,var(--color-ink)_42%,transparent)] uppercase',
                  large && 'text-[.8rem]',
                ]}>Next</span
              >
              <span
                class={[
                  'truncate font-sans text-[.74rem] leading-normal font-medium text-[color-mix(in_srgb,var(--color-ink)_72%,transparent)]',
                  large && 'text-[1.2rem]',
                ]}>{nextSong.name}</span
              >
            {:else}
              <span
                class={['font-sans text-[.74rem] leading-normal', large && 'text-[1.2rem]']}
                aria-hidden="true">&nbsp;</span
              >
            {/if}
          </div>
        </Card>

        <!-- Two equal cells. The one that matters most is the one wearing the
           accent, not the one that got extra width. -->
        <div
          class={['grid grid-cols-2 gap-[.3rem]', stageColumn]}
          role="group"
          aria-label="Song transport"
        >
          <Button
            block
            size={large ? 'lg' : 'md'}
            class={controlRowHeight}
            learn={learnStateOf(learn, 'songPrev')}
            disabled={!learn.on && (busy || !prevSong)}
            aria-label={learn.on ? learn.tip('songPrev', 'Previous') : 'Previous song'}
            tip={learn.on
              ? learn.tip('songPrev', 'Previous')
              : prevSong
                ? `Back to ${prevSong.name}`
                : 'At the first song'}
            onclick={() => (learn.on ? learn.click('songPrev') : go(prevSong))}
          >
            <CaretLeftIcon size={15} weight="bold" aria-hidden="true" />
            Prev
          </Button>
          <Button
            block
            tone="accent"
            size={large ? 'lg' : 'md'}
            class={controlRowHeight}
            learn={learnStateOf(learn, 'songNext')}
            disabled={!learn.on && (busy || !nextSong)}
            aria-label={learn.on ? learn.tip('songNext', 'Next') : 'Next song'}
            tip={learn.on
              ? learn.tip('songNext', 'Next')
              : nextSong
                ? `On to ${nextSong.name}`
                : 'At the last song'}
            onclick={() => (learn.on ? learn.click('songNext') : go(nextSong))}
          >
            Next
            <CaretRightIcon size={15} weight="bold" aria-hidden="true" />
          </Button>
        </div>

        <!-- The hinge: this is what Prev and Next walk, and the list below is it. -->
        <div class={['flex flex-none items-center gap-[.3rem]', stageColumn]}>
          <Select
            options={sourceOptions}
            value={appSettings.activeSetlistId}
            placeholder="All songs"
            aria-label="What Prev and Next walk"
            size="md"
            variant="plain"
            disabled={busy}
            filterable={appSettings.setlists.length > 6}
            filterPlaceholder="Filter setlists…"
            class={['min-w-0 flex-1', controlRowHeight]}
            onSelect={selectSource}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                creating = false;
                atSetlistCap = false;
              }
            }}
          >
            <!-- Making a set is part of choosing one, so it lives at the foot of
               the menu you already opened to pick — not behind an Edit button
               that only means anything once a set is selected. -->
            {#snippet footer(close)}
              <SaveAsRow
                bind:editing={creating}
                label="New setlist…"
                placeholder="Setlist name"
                inputLabel="Setlist name"
                dense
                onSave={(name) => {
                  if (commitCreate(name)) close();
                }}
              />
              {#if atSetlistCap}
                <p
                  class="m-0 px-3 py-1 font-sans text-[.68rem] leading-normal font-medium text-warn"
                >
                  Setlist limit reached. Delete one first.
                </p>
              {/if}
            {/snippet}
          </Select>
          {#if editMode && activeSetlist}
            <!-- Fades: the picker row it joins is there in both modes, so only
                 the pen itself appears. -->
            <div class="flex items-center" transition:fade={reveal.fade()}>
              <IconButton
                size="md"
                class={['aspect-square w-auto', controlRowHeight]}
                label="Edit {activeSetlist.name}"
                tip="Rename or delete this setlist"
                aria-expanded={setlistEditorOpen}
                onclick={() => {
                  setlistEditorOpen = !setlistEditorOpen;
                  confirmingDelete = false;
                }}
              >
                <PencilSimpleIcon size={18} />
              </IconButton>
            </div>
          {/if}
        </div>

        <!-- One pen, one section — the same bargain the song rows make. Creating
           is not here: it belongs to the picker, which is where you go when the
           set you want doesn't exist yet. -->
        {#if editMode && setlistEditorOpen && activeSetlist}
          <div
            class="flex flex-none flex-col gap-[.3rem] border-l-2 border-control-edge py-[.35rem] pr-[.4rem] pl-2"
            transition:slide={reveal.slide()}
          >
            <label class="flex items-center gap-[.45rem]">
              <span
                class="w-[2.6rem] flex-none font-mono text-[.62rem] leading-normal font-semibold tracking-[.06em] text-muted uppercase"
                >Name</span
              >
              <TextField
                size="sm"
                class="flex-1"
                value={activeSetlist.name}
                aria-label="Name for {activeSetlist.name}"
                onchange={(e) => commitSetlistName(e.currentTarget.value, e.currentTarget)}
              />
            </label>
            {#if confirmingDelete}
              <InlineConfirmRow
                message="Delete the setlist “{activeSetlist.name}”?"
                confirmLabel="Delete"
                dense
                stacked
                onConfirm={commitDelete}
                onCancel={() => (confirmingDelete = false)}
              />
            {:else}
              <Button
                variant="ghost"
                size="sm"
                tone="warn"
                class="ml-[3.05rem] self-start"
                tip="Delete the running order — the songs stay in the library"
                onclick={() => (confirmingDelete = true)}
              >
                Delete setlist
              </Button>
            {/if}
          </div>
        {/if}

        <!-- Only the running order scrolls, docked *and* on the stage: the card,
           the transport and the source picker are what the player reads between
           songs, so they must not be able to leave the top of the panel. The
           section takes the panel's height so this box has one to fill. -->
        <div class={['min-h-0 flex-1 overflow-y-auto', stageColumn]}>
          <SongList
            {appSettings}
            {onSetAppSettings}
            {rigs}
            {sceneState}
            {busy}
            {editMode}
            onRecall={go}
          />
        </div>
      {/if}
    {/snippet}
  </MidiLearn>
</section>
