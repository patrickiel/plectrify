<script lang="ts">
  import { untrack } from 'svelte';
  import type { Rig, SceneState, Song } from '../../lib/engine/types';
  import { MAX_NOTE_LENGTH } from '../../lib/engine/songs';
  import Button from '../../lib/components/Button.svelte';
  import InlineConfirmRow from '../../lib/components/InlineConfirmRow.svelte';
  import Select from '../../lib/components/Select.svelte';
  import TextField from '../../lib/components/TextField.svelte';

  /**
   * Everything about one song, in one place: its name, what it recalls, its
   * stage note, and its removal from the book.
   *
   * The name lives here rather than behind a separate rename mode on the row.
   * Splitting them made the row carry two pencils for one idea — "the name" and
   * "what it does" are the same edit as far as the player is concerned, and a
   * rename that swaps the whole row away hides the very fields you came to
   * check it against.
   *
   * Nothing here writes per keystroke: every mutation rewrites settings.json
   * whole over the bridge, so the text fields commit on `change` (blur/Enter)
   * and the selects on pick.
   */
  interface Props {
    song: Song;
    rigs: Rig[];
    sceneState: SceneState;
    /** The rig loaded right now — what "keep current" and the scene check mean. */
    activeRigId: string;
    onPatch: (fields: Partial<Omit<Song, 'id'>>) => void;
    onDelete: () => void;
  }

  let { song, rigs, sceneState, activeRigId, onPatch, onDelete }: Props = $props();

  let confirmingDelete = $state(false);
  /** Seeded once — `untrack` says so out loud: the editor mounts per song and
      unmounts when it closes, and nothing outside this panel renames a song
      under it, so following the prop would only fight the typist. */
  let nameDraft = $state(untrack(() => song.name));

  const rigOptions = $derived([
    { value: '', label: '— Keep current rig —' },
    ...rigs.map((rig) => ({ value: rig.id, label: rig.name })),
  ]);
  const sceneOptions = $derived([
    { value: '', label: '— Keep current scene —' },
    ...sceneState.scenes.map((scene) => ({ value: scene.id, label: scene.name })),
  ]);

  /** Why this song's scene can't be picked right now, or null when it can.
      Scenes are rig-scoped and only the loaded rig's list crosses the bridge,
      so choosing one for a song that lives on another rig is impossible until
      that rig is up — which is a different problem from a rig that simply has
      no scenes, and the two must not share a message. */
  const sceneBlocker = $derived.by(() => {
    if ((song.rigId ?? activeRigId) !== activeRigId)
      return song.sceneId ? 'Set. Load this song’s rig to change it' : 'Load this song’s rig first';
    if (sceneState.scenes.length === 0) return 'This rig has no scenes';
    return null;
  });

  const labelClass =
    'w-[2.6rem] flex-none font-mono text-[.62rem] leading-normal font-semibold tracking-[.06em] text-muted uppercase';

  /** An empty name is a no-op, not a clear — a song with no name is unusable in
      a list you read from standing distance. Put the old one back rather than
      leave the field looking as though it took. */
  function commitName() {
    const name = nameDraft.trim();
    if (name) onPatch({ name });
    else nameDraft = song.name;
  }
</script>

<!-- An empty choice is "keep current", not "reset": a song that says nothing
     about the rig must leave the player's sound alone. Changing the rig clears
     the scene, because a scene id only means anything inside the rig it was
     captured in. -->
<div
  class="mx-[.3rem] mt-0 mb-[.35rem] ml-[1.05rem] flex flex-col gap-[.3rem] border-l-2 border-control-edge pt-[.35rem] pr-[.4rem] pb-[.45rem] pl-2"
>
  <label class="flex items-center gap-[.45rem]">
    <span class={labelClass}>Name</span>
    <TextField
      size="sm"
      class="flex-1"
      bind:value={nameDraft}
      aria-label="Name for {song.name}"
      onchange={commitName}
    />
  </label>

  <div class="flex items-center gap-[.45rem]">
    <span class={labelClass}>Rig</span>
    <Select
      options={rigOptions}
      value={song.rigId ?? ''}
      placeholder="— Keep current rig —"
      filterPlaceholder="Filter rigs…"
      aria-label="Rig for {song.name}"
      size="sm"
      variant="plain"
      class="flex-1"
      onSelect={(value) => onPatch({ rigId: value || undefined, sceneId: undefined })}
    />
  </div>

  <div class="flex items-center gap-[.45rem]">
    <span class={labelClass}>Scene</span>
    {#if sceneBlocker === null}
      <Select
        options={sceneOptions}
        value={song.sceneId ?? ''}
        placeholder="— Keep current scene —"
        filterPlaceholder="Filter scenes…"
        aria-label="Scene for {song.name}"
        size="sm"
        variant="plain"
        class="flex-1"
        onSelect={(value) => onPatch({ sceneId: value || undefined })}
      />
    {:else}
      <span
        class="min-w-0 flex-1 font-sans text-[.68rem] leading-normal font-medium text-muted italic"
        >{sceneBlocker}</span
      >
    {/if}
  </div>

  <label class="flex items-center gap-[.45rem]">
    <span class={labelClass}>Note</span>
    <TextField
      size="sm"
      class="flex-1"
      value={song.notes ?? ''}
      maxlength={MAX_NOTE_LENGTH}
      placeholder="Key, tuning, count-in…"
      aria-label="Stage note for {song.name}"
      onchange={(e) => onPatch({ notes: e.currentTarget.value.trim() || undefined })}
    />
  </label>

  {#if confirmingDelete}
    <InlineConfirmRow
      message="Delete “{song.name}”?"
      confirmLabel="Delete"
      dense
      stacked
      onConfirm={onDelete}
      onCancel={() => (confirmingDelete = false)}
    />
  {:else}
    <div class="ml-[3.05rem] flex items-center justify-between gap-2 pt-[.1rem]">
      <Button
        variant="ghost"
        size="sm"
        tip="Point this song at the rig and scene loaded right now"
        onclick={() =>
          onPatch({
            rigId: activeRigId || undefined,
            sceneId: sceneState.activeSceneId ?? undefined,
          })}
      >
        Use what’s loaded now
      </Button>
      <Button
        variant="ghost"
        size="sm"
        tone="warn"
        tip="Delete from the library and every setlist"
        onclick={() => (confirmingDelete = true)}
      >
        Delete song
      </Button>
    </div>
  {/if}
</div>
