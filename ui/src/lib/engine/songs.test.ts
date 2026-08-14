import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from './appSettings';
import {
  MAX_NOTE_LENGTH,
  MAX_SETLISTS,
  MAX_SONGS,
  addSong,
  addableSongs,
  addToSetlist,
  captureSong,
  createSetlist,
  deleteSetlist,
  deleteSong,
  findSetlist,
  moveSong,
  moveSongInSetlist,
  normalizeActiveSetlistId,
  normalizeActiveSongId,
  normalizeSetlists,
  normalizeSongs,
  playOrder,
  removeFromSetlist,
  renameSetlist,
  renameSong,
  songHealth,
  stepSong,
  updateSong,
} from './songs';
import type { AppSettings, Scene, Setlist, Song } from './types';

const song = (id: string, extra: Partial<Song> = {}): Song => ({ id, name: id, ...extra });

const settingsWith = (patch: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...patch,
});

const scene = (id: string): Scene => ({ id, name: id, modules: [], lanes: [], switches: [] });

describe('normalizeSongs', () => {
  it('falls back to an empty library for garbage', () => {
    expect(normalizeSongs(null)).toEqual([]);
    expect(normalizeSongs('songs')).toEqual([]);
    expect(normalizeSongs({ 0: song('a') })).toEqual([]);
  });

  it('drops malformed songs individually while good neighbours survive', () => {
    expect(
      normalizeSongs([
        song('a'),
        { id: '', name: 'no id' },
        { id: 'b' }, // no name
        { name: 'no id at all' },
        null,
        song('c'),
      ]),
    ).toEqual([song('a'), song('c')]);
  });

  it('rebuilds field by field so stray properties never survive a load', () => {
    expect(normalizeSongs([{ id: 'a', name: 'A', tempo: 120, colour: 'red' }])).toEqual([
      { id: 'a', name: 'A', rigId: undefined, sceneId: undefined, notes: undefined },
    ]);
  });

  it('drops non-string and empty recall targets to undefined, never to an empty string', () => {
    const [only] = normalizeSongs([{ id: 'a', name: 'A', rigId: 7, sceneId: '', notes: null }]);
    expect(only.rigId).toBeUndefined();
    expect(only.sceneId).toBeUndefined();
    expect(only.notes).toBeUndefined();
  });

  it('de-duplicates ids, keeping the first', () => {
    expect(normalizeSongs([song('a', { name: 'first' }), song('a', { name: 'second' })])).toEqual([
      { id: 'a', name: 'first', rigId: undefined, sceneId: undefined, notes: undefined },
    ]);
  });

  it('truncates an over-long note and caps the library', () => {
    const [only] = normalizeSongs([
      { id: 'a', name: 'A', notes: 'x'.repeat(MAX_NOTE_LENGTH + 50) },
    ]);
    expect(only.notes).toHaveLength(MAX_NOTE_LENGTH);
    const many = Array.from({ length: MAX_SONGS + 20 }, (_, i) => song(`s${i}`));
    expect(normalizeSongs(many)).toHaveLength(MAX_SONGS);
  });
});

describe('normalizeSetlists', () => {
  const library = [song('a'), song('b'), song('c')];

  it('drops song ids absent from the library', () => {
    expect(
      normalizeSetlists([{ id: 'l', name: 'Set', songIds: ['a', 'ghost', 'c'] }], library),
    ).toEqual([{ id: 'l', name: 'Set', songIds: ['a', 'c'] }]);
  });

  it('de-duplicates within one list, keeping the first appearance', () => {
    expect(
      normalizeSetlists([{ id: 'l', name: 'Set', songIds: ['b', 'a', 'b'] }], library)[0].songIds,
    ).toEqual(['b', 'a']);
  });

  it('drops a setlist with no name or a non-array song list', () => {
    expect(normalizeSetlists([{ id: 'l', name: 'Set' }], library)).toEqual([]);
    expect(normalizeSetlists([{ id: 'l', name: 'Set', songIds: 'a,b' }], library)).toEqual([]);
    expect(normalizeSetlists([{ id: 'l', songIds: [] }], library)).toEqual([]);
    expect(normalizeSetlists('sets', library)).toEqual([]);
  });

  it('de-duplicates setlist ids and caps the count', () => {
    expect(
      normalizeSetlists(
        [
          { id: 'l', name: 'First', songIds: [] },
          { id: 'l', name: 'Second', songIds: [] },
        ],
        library,
      ),
    ).toEqual([{ id: 'l', name: 'First', songIds: [] }]);
    const many = Array.from({ length: MAX_SETLISTS + 10 }, (_, i) => ({
      id: `l${i}`,
      name: `Set ${i}`,
      songIds: [],
    }));
    expect(normalizeSetlists(many, library)).toHaveLength(MAX_SETLISTS);
  });
});

describe('normalizeActiveSetlistId / normalizeActiveSongId', () => {
  const setlists: Setlist[] = [{ id: 'l', name: 'Set', songIds: [] }];
  const songs = [song('a')];

  it('keeps a live selection', () => {
    expect(normalizeActiveSetlistId('l', setlists)).toBe('l');
    expect(normalizeActiveSongId('a', songs)).toBe('a');
  });

  it('clears a selection whose target is gone, and any non-string', () => {
    expect(normalizeActiveSetlistId('gone', setlists)).toBe('');
    expect(normalizeActiveSetlistId(7, setlists)).toBe('');
    expect(normalizeActiveSongId('gone', songs)).toBe('');
    expect(normalizeActiveSongId(null, songs)).toBe('');
  });
});

describe('playOrder', () => {
  const songs = [song('a'), song('b'), song('c')];

  it('walks the whole library when no setlist is selected', () => {
    expect(playOrder(settingsWith({ songs })).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('walks the active setlist in its own order', () => {
    const settings = settingsWith({
      songs,
      setlists: [{ id: 'l', name: 'Set', songIds: ['c', 'a'] }],
      activeSetlistId: 'l',
    });
    expect(playOrder(settings).map((s) => s.id)).toEqual(['c', 'a']);
    expect(findSetlist(settings)?.name).toBe('Set');
  });

  it('falls back to the library when the selected setlist is gone', () => {
    const settings = settingsWith({ songs, activeSetlistId: 'gone' });
    expect(playOrder(settings).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(findSetlist(settings)).toBeNull();
  });

  it('skips a setlist reference with no matching library song', () => {
    const settings = settingsWith({
      songs,
      setlists: [{ id: 'l', name: 'Set', songIds: ['a', 'ghost'] }],
      activeSetlistId: 'l',
    });
    expect(playOrder(settings).map((s) => s.id)).toEqual(['a']);
  });

  it('returns an empty order for an empty library', () => {
    expect(playOrder(settingsWith({}))).toEqual([]);
  });
});

describe('stepSong', () => {
  const order = [song('a'), song('b'), song('c')];

  it('steps forward and back', () => {
    expect(stepSong(order, 'a', 1)?.id).toBe('b');
    expect(stepSong(order, 'c', -1)?.id).toBe('b');
  });

  it('clamps at both ends rather than wrapping', () => {
    expect(stepSong(order, 'c', 1)).toBeNull();
    expect(stepSong(order, 'a', -1)).toBeNull();
  });

  it('starts at the first song forward and the last backward with no active song', () => {
    expect(stepSong(order, '', 1)?.id).toBe('a');
    expect(stepSong(order, '', -1)?.id).toBe('c');
  });

  it('treats an unknown active id as no active song', () => {
    expect(stepSong(order, 'deleted', 1)?.id).toBe('a');
  });

  it('returns null for an empty order', () => {
    expect(stepSong([], '', 1)).toBeNull();
    expect(stepSong([], 'a', -1)).toBeNull();
  });
});

describe('library edits', () => {
  const songs = [song('a'), song('b'), song('c')];

  it('moves a song, clamping out-of-range targets', () => {
    expect(moveSong(songs, 'c', 0).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(moveSong(songs, 'a', 99).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(moveSong(songs, 'a', -5).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list identical for a no-op or unknown id', () => {
    expect(moveSong(songs, 'b', 1)).toBe(songs);
    expect(moveSong(songs, 'ghost', 0)).toBe(songs);
  });

  it('renames, ignoring an empty name', () => {
    expect(renameSong(songs, 'b', 'Wish You Were Here')[1].name).toBe('Wish You Were Here');
    expect(renameSong(songs, 'b', '')).toBe(songs);
  });

  it('clears a recall target when the patch sets it to undefined', () => {
    const mapped = updateSong(songs, 'a', { rigId: 'rig1', sceneId: 'sc1' });
    expect(mapped[0]).toMatchObject({ rigId: 'rig1', sceneId: 'sc1' });
    expect(updateSong(mapped, 'a', { sceneId: undefined })[0].sceneId).toBeUndefined();
  });

  it('deletes from the library and from every setlist', () => {
    const setlists: Setlist[] = [
      { id: 'l1', name: 'Early', songIds: ['a', 'b'] },
      { id: 'l2', name: 'Late', songIds: ['c'] },
    ];
    const next = deleteSong(songs, setlists, 'b');
    expect(next.songs.map((s) => s.id)).toEqual(['a', 'c']);
    expect(next.setlists[0].songIds).toEqual(['a']);
    // Untouched sets keep their identity, so unrelated rows don't re-render.
    expect(next.setlists[1]).toBe(setlists[1]);
  });
});

describe('setlist edits', () => {
  const setlists: Setlist[] = [{ id: 'l', name: 'Set', songIds: ['a', 'b'] }];

  it('appends and refuses a repeat', () => {
    expect(addToSetlist(setlists, 'l', 'c')[0].songIds).toEqual(['a', 'b', 'c']);
    expect(addToSetlist(setlists, 'l', 'a')[0].songIds).toEqual(['a', 'b']);
    expect(addToSetlist(setlists, 'ghost', 'c')[0].songIds).toEqual(['a', 'b']);
  });

  it('removes from one set without touching the library', () => {
    expect(removeFromSetlist(setlists, 'l', 'a')[0].songIds).toEqual(['b']);
    expect(removeFromSetlist(setlists, 'l', 'ghost')[0].songIds).toEqual(['a', 'b']);
  });

  it('reorders within a set, clamping out-of-range targets', () => {
    const three: Setlist[] = [{ id: 'l', name: 'Set', songIds: ['a', 'b', 'c'] }];
    expect(moveSongInSetlist(three, 'l', 'c', 0)[0].songIds).toEqual(['c', 'a', 'b']);
    expect(moveSongInSetlist(three, 'l', 'a', 99)[0].songIds).toEqual(['b', 'c', 'a']);
    expect(moveSongInSetlist(three, 'other', 'a', 0)[0].songIds).toEqual(['a', 'b', 'c']);
  });
});

describe('captureSong', () => {
  it('captures the live rig and scene', () => {
    expect(captureSong('s1', 'Song', { activeRigId: 'rig1', activeSceneId: 'sc1' })).toEqual({
      id: 's1',
      name: 'Song',
      rigId: 'rig1',
      sceneId: 'sc1',
    });
  });

  it('leaves the fields absent when nothing is loaded', () => {
    const captured = captureSong('s1', 'Song', { activeRigId: '', activeSceneId: null });
    expect(captured.rigId).toBeUndefined();
    expect(captured.sceneId).toBeUndefined();
  });
});

describe('addableSongs', () => {
  const library = [
    song('c', { name: 'Panama' }),
    song('a', { name: 'ain’t talkin’' }),
    song('b', { name: 'Bad' }),
    song('d', { name: 'Purple Haze' }),
  ];
  const setlist: Setlist = { id: 'l', name: 'Set', songIds: ['c'] };

  it('is empty without a set — the library already shows all of itself', () => {
    expect(addableSongs(library, null)).toEqual([]);
  });

  it('drops what is already in the set and sorts A–Z regardless of case', () => {
    expect(addableSongs(library, setlist).map((s) => s.name)).toEqual([
      'ain’t talkin’',
      'Bad',
      'Purple Haze',
    ]);
  });

  it('filters on a case-insensitive substring', () => {
    expect(addableSongs(library, setlist, 'ha').map((s) => s.name)).toEqual(['Purple Haze']);
    expect(addableSongs(library, setlist, '  BA ').map((s) => s.name)).toEqual(['Bad']);
    expect(addableSongs(library, setlist, 'panama')).toEqual([]);
  });

  it('leaves the library array itself unsorted', () => {
    addableSongs(library, setlist);
    expect(library.map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('addSong', () => {
  const setlists: Setlist[] = [{ id: 'l', name: 'Set', songIds: ['a'] }];

  it('appends to the library alone when no set is selected', () => {
    const next = addSong([song('a')], setlists, '', song('b'));
    expect(next.songs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(next.setlists).toBe(setlists);
  });

  it('also lands in the set the player is looking at', () => {
    const next = addSong([song('a')], setlists, 'l', song('b'));
    expect(next.songs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(next.setlists[0].songIds).toEqual(['a', 'b']);
  });

  it('refuses at the cap rather than appending a song a reload would drop', () => {
    const full = Array.from({ length: MAX_SONGS }, (_, i) => song(`s${i}`));
    const next = addSong(full, setlists, 'l', song('over'));
    expect(next.songs).toBe(full);
    expect(next.setlists).toBe(setlists);
  });
});

describe('setlist lifecycle', () => {
  it('creates an empty running order', () => {
    expect(createSetlist([], 'l1', 'Friday')).toEqual([{ id: 'l1', name: 'Friday', songIds: [] }]);
  });

  it('returns null at the cap so the caller can keep its input open', () => {
    const full = Array.from({ length: MAX_SETLISTS }, (_, i) => ({
      id: `l${i}`,
      name: `Set ${i}`,
      songIds: [],
    }));
    expect(createSetlist(full, 'over', 'Nope')).toBeNull();
  });

  it('renames, ignoring an empty name', () => {
    const setlists: Setlist[] = [{ id: 'l', name: 'Set', songIds: [] }];
    expect(renameSetlist(setlists, 'l', 'Saturday')[0].name).toBe('Saturday');
    expect(renameSetlist(setlists, 'l', '')).toBe(setlists);
    expect(renameSetlist(setlists, 'ghost', 'Saturday')[0].name).toBe('Set');
  });

  it('deletes the running order and leaves every song in the library', () => {
    const setlists: Setlist[] = [
      { id: 'l1', name: 'One', songIds: ['a'] },
      { id: 'l2', name: 'Two', songIds: ['a'] },
    ];
    expect(deleteSetlist(setlists, 'l1').map((l) => l.id)).toEqual(['l2']);
  });
});

describe('songHealth', () => {
  const rigs = [
    { id: 'rig1', name: 'Clean' },
    { id: 'rig2', name: 'Dirty' },
  ];
  const scenes = [scene('sc1')];

  it('is clean when both targets resolve and when the song recalls nothing', () => {
    expect(songHealth(song('a', { rigId: 'rig1', sceneId: 'sc1' }), rigs, scenes, 'rig1')).toEqual({
      rigMissing: false,
      sceneMissing: false,
    });
    expect(songHealth(song('a'), rigs, scenes, 'rig1')).toEqual({
      rigMissing: false,
      sceneMissing: false,
    });
  });

  it('flags each missing target independently', () => {
    expect(songHealth(song('a', { rigId: 'gone' }), rigs, scenes, 'rig1').rigMissing).toBe(true);
    expect(songHealth(song('a', { sceneId: 'gone' }), rigs, scenes, 'rig1').sceneMissing).toBe(
      true,
    );
    expect(songHealth(song('a', { rigId: 'rig1', sceneId: 'gone' }), rigs, scenes, 'rig1')).toEqual(
      { rigMissing: false, sceneMissing: true },
    );
  });

  it('does not judge the scene of a song whose rig is not the one loaded', () => {
    // rig2's scenes are not in hand, so 'sc-other' is unknowable, not missing —
    // otherwise every song in a set would show broken while another rig is up.
    expect(
      songHealth(song('a', { rigId: 'rig2', sceneId: 'sc-other' }), rigs, scenes, 'rig1'),
    ).toEqual({ rigMissing: false, sceneMissing: false });
  });
});
