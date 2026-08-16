import type { AppSettings, Rig, Scene, Setlist, Song } from './types';

/**
 * Pure song-library and setlist logic: normalization, ordering, and the list
 * edits the panel makes. No engine or UI imports, so every rule here is
 * unit-testable.
 *
 * The model is two levels and the library is the primary one. A `Song` owns all
 * of its data; a `Setlist` is only a name plus an ordered list of song ids.
 * That split is what makes building tonight's set cheap — the notes and rig
 * mappings come along by reference — and it is why `playOrder` treats "no
 * setlist selected" as a real state rather than an error: a player who calls
 * songs spontaneously never makes a setlist at all.
 */

/** Library cap. Not a UI limit anyone will reach by hand — it exists so a
    corrupt or scripted settings.json can't grow the file without bound, since
    every mutation rewrites it whole over the bridge. */
export const MAX_SONGS = 500;
export const MAX_SETLISTS = 50;
/** Stage notes are read at a glance from standing distance, not stored prose. */
export const MAX_NOTE_LENGTH = 240;

/** An optional string field rebuilt from persisted data: kept only when it is a
    non-empty string. Absent and empty must not be distinguishable — both mean
    "this song says nothing about that", and `''` leaking through would render
    as an empty chip. */
function optionalText(value: unknown, maxLength = 0): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return maxLength > 0 ? value.slice(0, maxLength) : value;
}

/** Parse persisted library content, dropping malformed songs individually
    rather than failing the whole list, and rebuilding each field by field so
    stray extra properties don't survive a load. */
export function normalizeSongs(parsed: unknown): Song[] {
  if (!Array.isArray(parsed)) return [];
  const songs: Song[] = [];
  const seen = new Set<string>();
  for (const raw of parsed as Partial<Song>[]) {
    if (typeof raw?.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
    if (typeof raw.name !== 'string' || !raw.name) continue;
    seen.add(raw.id);
    songs.push({
      id: raw.id,
      name: raw.name,
      rigId: optionalText(raw.rigId),
      sceneId: optionalText(raw.sceneId),
      notes: optionalText(raw.notes, MAX_NOTE_LENGTH),
    });
    if (songs.length >= MAX_SONGS) break;
  }
  return songs;
}

/** Parse persisted setlists against the library that survived normalization.
    Song ids that no longer resolve are dropped: this is the backstop that keeps
    a deleted library song from lingering as a hole in every set. Duplicates
    within one list are dropped too — the play cursor is a song id, so the same
    song twice would have no single position. */
export function normalizeSetlists(parsed: unknown, songs: Song[]): Setlist[] {
  if (!Array.isArray(parsed)) return [];
  const known = new Set(songs.map((song) => song.id));
  const setlists: Setlist[] = [];
  const seen = new Set<string>();
  for (const raw of parsed as Partial<Setlist>[]) {
    if (typeof raw?.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
    if (typeof raw.name !== 'string' || !raw.name) continue;
    if (!Array.isArray(raw.songIds)) continue;
    seen.add(raw.id);
    const songIds: string[] = [];
    for (const songId of raw.songIds)
      if (typeof songId === 'string' && known.has(songId) && !songIds.includes(songId))
        songIds.push(songId);
    setlists.push({ id: raw.id, name: raw.name, songIds });
    if (setlists.length >= MAX_SETLISTS) break;
  }
  return setlists;
}

/** Keep a persisted setlist selection only while it names a live setlist;
    otherwise fall back to '' — the library, which always exists. */
export function normalizeActiveSetlistId(value: unknown, setlists: Setlist[]): string {
  return typeof value === 'string' && setlists.some((list) => list.id === value) ? value : '';
}

/** Keep the play cursor only while it names a live song. Deliberately checked
    against the library and not the active setlist: recalling a song from the
    library while a set is selected is legitimate (the player went off-script),
    and the cursor should survive it. */
export function normalizeActiveSongId(value: unknown, songs: Song[]): string {
  return typeof value === 'string' && songs.some((song) => song.id === value) ? value : '';
}

export function findSetlist(settings: AppSettings): Setlist | null {
  return settings.setlists.find((list) => list.id === settings.activeSetlistId) ?? null;
}

/** The songs next/prev walks: the active setlist's, in its order, or the whole
    library when no setlist is selected. Everything downstream consumes a plain
    `Song[]` and never needs to know which case it is in. */
export function playOrder(settings: AppSettings): Song[] {
  const setlist = findSetlist(settings);
  if (!setlist) return settings.songs;
  const byId = new Map(settings.songs.map((song) => [song.id, song]));
  return setlist.songIds
    .map((songId) => byId.get(songId))
    .filter((song): song is Song => song !== undefined);
}

/** Next/prev over a play order. **Clamps, and deliberately does not wrap** —
    unlike `stepIndex` in midi.ts, which serves rig/scene selects. A set is not
    a loop: "next" pressed on the last song during an encore must do nothing,
    not silently reload the opener. With no active song (or one that has since
    been deleted) next lands on the first and prev on the last. */
export function stepSong(order: Song[], activeId: string, delta: 1 | -1): Song | null {
  if (order.length === 0) return null;
  const from = order.findIndex((song) => song.id === activeId);
  if (from < 0) return delta === 1 ? order[0] : order[order.length - 1];
  const to = from + delta;
  return to >= 0 && to < order.length ? order[to] : null;
}

/** Move an item within a list by id, returning a new array. Out-of-range
    targets clamp and an unknown id is a no-op, so a stale drag can't reorder
    something the user isn't looking at. */
function moveById<T extends { id: string }>(items: T[], id: string, toIndex: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return items;
  const to = Math.max(0, Math.min(items.length - 1, Math.trunc(toIndex)));
  if (to === from) return items;
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function moveSong(songs: Song[], id: string, toIndex: number): Song[] {
  return moveById(songs, id, toIndex);
}

export function renameSong(songs: Song[], id: string, name: string): Song[] {
  if (!name) return songs;
  return songs.map((song) => (song.id === id ? { ...song, name } : song));
}

/** Replace a song's recall targets. Passing `undefined` for a field clears it
    back to "leave that alone", which is why the patch is spread over the song
    rather than merged: `{ rigId: undefined }` has to actually remove the rig. */
export function updateSong(songs: Song[], id: string, patch: Partial<Omit<Song, 'id'>>): Song[] {
  return songs.map((song) => (song.id === id ? { ...song, ...patch } : song));
}

/** Delete from the library **and** from every setlist. Normalization would drop
    the dangling references on the next load anyway, but doing it here means the
    panel updates in the same write the user's click caused. */
export function deleteSong(
  songs: Song[],
  setlists: Setlist[],
  id: string,
): { songs: Song[]; setlists: Setlist[] } {
  return {
    songs: songs.filter((song) => song.id !== id),
    setlists: setlists.map((list) =>
      list.songIds.includes(id)
        ? { ...list, songIds: list.songIds.filter((songId) => songId !== id) }
        : list,
    ),
  };
}

/** Append to a setlist, ignoring a song already in it (the no-repeat rule) and
    one that isn't in the library. */
export function addToSetlist(setlists: Setlist[], setlistId: string, songId: string): Setlist[] {
  return setlists.map((list) =>
    list.id === setlistId && !list.songIds.includes(songId)
      ? { ...list, songIds: [...list.songIds, songId] }
      : list,
  );
}

/** Drop a song from one set. Never touches the library — removing a song from
    tonight's running order must not lose its notes. */
export function removeFromSetlist(
  setlists: Setlist[],
  setlistId: string,
  songId: string,
): Setlist[] {
  return setlists.map((list) =>
    list.id === setlistId ? { ...list, songIds: list.songIds.filter((id) => id !== songId) } : list,
  );
}

export function moveSongInSetlist(
  setlists: Setlist[],
  setlistId: string,
  songId: string,
  toIndex: number,
): Setlist[] {
  return setlists.map((list) => {
    if (list.id !== setlistId) return list;
    const moved = moveById(
      list.songIds.map((id) => ({ id })),
      songId,
      toIndex,
    );
    return { ...list, songIds: moved.map((item) => item.id) };
  });
}

/** Build a library song from what is loaded right now — the "add current"
    button. An empty rig or scene selection yields an absent field, not '', so
    the song stays honest about recalling nothing. */
export function captureSong(
  id: string,
  name: string,
  live: { activeRigId: string; activeSceneId: string | null },
): Song {
  return {
    id,
    name,
    rigId: optionalText(live.activeRigId),
    sceneId: optionalText(live.activeSceneId),
  };
}

/** The songs that can still be added to a set: everything not already in it,
 **always A–Z** and narrowed by an optional filter.
 *
 * Alphabetical rather than library order on purpose. The running order above it
 * is a sequence the player authored and reads positionally; this is a pool they
 * search by name, and a pool ordered by when each song happened to be added is
 * one you have to read end to end every time. */
export function addableSongs(songs: Song[], setlist: Setlist | null, query = ''): Song[] {
  if (!setlist) return [];
  const inSet = new Set(setlist.songIds);
  const needle = query.trim().toLowerCase();
  return songs
    .filter((song) => !inSet.has(song.id) && (!needle || song.name.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Put a captured song in the book, and in the set the player is looking at.
 *
 * The setlist half is what makes the merged list honest: the panel shows one
 * running order, so a song added while a set is up has to land *in* that set —
 * adding to a list you are not looking at would be the same lie the old
 * library/setlist tab split told.
 *
 * Refuses at {@link MAX_SONGS} rather than appending. Normalization truncates
 * to the same cap on every write, so an unchecked append doesn't fail loudly —
 * the song simply isn't there after the next load. */
export function addSong(
  songs: Song[],
  setlists: Setlist[],
  activeSetlistId: string,
  song: Song,
): { songs: Song[]; setlists: Setlist[] } {
  if (songs.length >= MAX_SONGS) return { songs, setlists };
  return {
    songs: [...songs, song],
    setlists: activeSetlistId ? addToSetlist(setlists, activeSetlistId, song.id) : setlists,
  };
}

/** Append an empty running order, or null at {@link MAX_SETLISTS} so the caller
    can leave its input open instead of appearing to have saved. */
export function createSetlist(setlists: Setlist[], id: string, name: string): Setlist[] | null {
  if (setlists.length >= MAX_SETLISTS) return null;
  return [...setlists, { id, name, songIds: [] }];
}

export function renameSetlist(setlists: Setlist[], id: string, name: string): Setlist[] {
  if (!name) return setlists;
  return setlists.map((list) => (list.id === id ? { ...list, name } : list));
}

/** Drop a running order. Every song stays in the library — that separation is
    the whole reason the two levels exist. */
export function deleteSetlist(setlists: Setlist[], id: string): Setlist[] {
  return setlists.filter((list) => list.id !== id);
}

/** Whether a song's recall targets still exist. Drives the row's warning badge;
    recall itself skips a missing target and carries on rather than failing, so
    one deleted rig never blocks the rest of a set.
 *
 * The scene can only be judged for a song whose rig is the one currently
 * loaded — scenes are rig-scoped and the UI only ever holds the active rig's
 * list, so checking any other song's scene would flag every song in the set as
 * broken the moment a different rig is up. A song with no rig of its own plays
 * on whatever is loaded, so its scene is judged against that. */
export function songHealth(
  song: Song,
  rigs: Rig[],
  scenes: Scene[],
  activeRigId: string,
): { rigMissing: boolean; sceneMissing: boolean } {
  const sceneKnowable = (song.rigId ?? activeRigId) === activeRigId;
  return {
    rigMissing: song.rigId !== undefined && !rigs.some((rig) => rig.id === song.rigId),
    sceneMissing:
      song.sceneId !== undefined &&
      sceneKnowable &&
      !scenes.some((scene) => scene.id === song.sceneId),
  };
}
