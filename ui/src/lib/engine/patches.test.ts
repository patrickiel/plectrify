import { describe, expect, it } from 'vitest';
import {
  LEGACY_INDEX_FILE,
  LEGACY_PATCH_DIR,
  byName,
  isStoredPatch,
  legacyPatchIdsFrom,
  legacyPatchPath,
  mergePatches,
  patchIdsFrom,
  patchPath,
  patchTitleOverride,
  sharedPatchIdsFrom,
  storedFromModule,
  toPatch,
  type StoredPatch,
} from './patches';
import type { MappedParam, Patch, RackModule } from './types';

const knob = (over: Partial<MappedParam> & { paramIndex: number }): MappedParam => ({
  knobId: `k${over.paramIndex}`,
  label: 'Gain',
  value: 0.5,
  ...over,
});

const module = (over: Partial<RackModule> = {}): RackModule => ({
  id: 'm1',
  name: 'Mock Amp',
  bypassed: false,
  params: [],
  availableParams: [],
  ...over,
});

const stored = (name: string): StoredPatch => ({ name, pluginName: 'Mock Amp', knobs: [] });

describe('storedFromModule', () => {
  it('falls back to the plugin name for an empty name', () => {
    expect(storedFromModule(module(), '  ').name).toBe('Mock Amp');
    expect(storedFromModule(module(), ' Lead ').name).toBe('Lead');
  });

  it('captures the plugin the mapping was built for', () => {
    expect(storedFromModule(module(), 'x').pluginName).toBe('Mock Amp');
  });

  it('normalizes knob positions so a saved layout survives gaps', () => {
    const p = storedFromModule(
      module({ params: [knob({ paramIndex: 1, pos: 3 }), knob({ paramIndex: 2, pos: 3 })] }),
      'x',
    );
    expect(p.knobs.map((k) => k.pos)).toEqual([3, 0]);
  });

  it('carries the mapping fields and nothing else', () => {
    const p = storedFromModule(
      module({
        params: [
          knob({
            paramIndex: 4,
            label: 'Out',
            isMeter: true,
            meterBipolar: true,
            value: 0.9,
            text: '-3 dB',
            midi: { type: 'cc', channel: 1, number: 7 },
          }),
        ],
      }),
      'x',
    );
    // Values come back from the state blob, not from the mapping; MIDI is rig
    // wiring and never travels with a patch.
    expect(p.knobs[0]).toEqual({
      paramIndex: 4,
      label: 'Out',
      isMeter: true,
      meterBipolar: true,
      pos: 0,
    });
  });

  it('carries the card’s look, so a patch restores the module it was saved from', () => {
    const p = storedFromModule(
      module({
        displayName: 'Lead Amp',
        color: '#c04a2b',
        styleVariant: 'bold',
        icon: 'amp',
        texture: 'tolex',
      }),
      'x',
    );
    expect(p.displayName).toBe('Lead Amp');
    expect(p.color).toBe('#c04a2b');
    expect(p.styleVariant).toBe('bold');
    expect(p.icon).toBe('amp');
    expect(p.texture).toBe('tolex');
  });

  it('leaves the look unset for a module still at its defaults', () => {
    // Unset means "leave the card alone" on load, not "clear it".
    const p = storedFromModule(module(), 'x');
    expect(p.displayName).toBeUndefined();
    expect(p.color).toBeUndefined();
    expect(p.styleVariant).toBeUndefined();
    expect(p.icon).toBeUndefined();
    expect(p.texture).toBeUndefined();
  });

  it('leaves the tone to the caller, which is the only side that can ask for it', () => {
    expect(storedFromModule(module(), 'x').state).toBeUndefined();
  });
});

describe('patchPath', () => {
  it('names one file per patch under the user’s patches directory', () => {
    expect(patchPath('patch-7a2')).toBe('patches/patch-7a2.patch');
  });

  it('is a folder in the shared root, so a patch can sit beside its assets', () => {
    // No `patches/` prefix: the shared root is itself the patches folder.
    expect(patchPath('amps_jtm45', 'shared')).toBe('amps_jtm45/patch.json');
  });

  it('refuses an id that could steer the path', () => {
    // These reach a delete, so the gate matters more than the read.
    expect(patchPath('../../evil')).toBeNull();
    expect(patchPath('a/b')).toBeNull();
    expect(patchPath('', 'shared')).toBeNull();
  });
});

describe('patchIdsFrom', () => {
  it('reads the ids back off the file names', () => {
    expect(patchIdsFrom(['p1.patch', 'amps_jtm45.patch'])).toEqual(['p1', 'amps_jtm45']);
  });

  it('leaves files it does not own alone', () => {
    expect(patchIdsFrom(['PROVENANCE.txt', 'notes.json', 'p1'])).toEqual([]);
  });

  it('drops a name that could not have been written by us', () => {
    expect(patchIdsFrom(['../evil.patch', 'a b.patch'])).toEqual([]);
  });
});

describe('the pre-rename layout', () => {
  // These three names are what is on users' disks, so they are asserted
  // literally: a later sweep that renames them would migrate nothing and the
  // files would simply stop being found.
  it('still reads patches from where presets were kept', () => {
    expect(LEGACY_PATCH_DIR).toBe('presets');
    expect(LEGACY_INDEX_FILE).toBe('presets.json');
    expect(legacyPatchPath('patch-7a2')).toBe('presets/patch-7a2.preset');
  });

  it('applies the same id gate as the new path, since the id carries across', () => {
    expect(legacyPatchPath('../../evil')).toBeNull();
    expect(legacyPatchPath('a/b')).toBeNull();
  });

  it('reads the ids back off the old file names', () => {
    expect(legacyPatchIdsFrom(['p1.preset', 'notes.json', 'p2.patch'])).toEqual(['p1']);
  });

  it('maps an old id onto its new home, which is what migrating one is', () => {
    const [id] = legacyPatchIdsFrom(['amps_jtm45.preset']);
    expect(patchPath(id!)).toBe('patches/amps_jtm45.patch');
  });
});

describe('sharedPatchIdsFrom', () => {
  it('takes one installed patch per folder', () => {
    expect(sharedPatchIdsFrom(['amps_jtm45', 'amps_plexi'])).toEqual(['amps_jtm45', 'amps_plexi']);
  });

  it('drops a folder name that could not have been written by us', () => {
    expect(sharedPatchIdsFrom(['..', 'a b', 'ok'])).toEqual(['ok']);
  });

  it('round-trips a folder name into the path its document lives at', () => {
    const [id] = sharedPatchIdsFrom(['amps_jtm45']);
    expect(patchPath(id!, 'shared')).toBe('amps_jtm45/patch.json');
  });
});

describe('isStoredPatch', () => {
  const valid = stored('Lead');

  it('accepts a mapping with or without a tone', () => {
    expect(isStoredPatch(valid)).toBe(true);
    expect(isStoredPatch({ ...valid, state: 'YmxvYg==', pluginVersion: '1.2' })).toBe(true);
  });

  it('accepts a card look, and only as strings', () => {
    // A patch file is hand-editable and a pack's is built elsewhere, so a
    // colour that is not a string must not reach the card.
    expect(isStoredPatch({ ...valid, displayName: 'Lead Amp', color: '#c04a2b' })).toBe(true);
    expect(isStoredPatch({ ...valid, color: 0xc04a2b })).toBe(false);
    expect(isStoredPatch({ ...valid, displayName: null })).toBe(false);
  });

  it('accepts the style fields string-typed, unknown ids included', () => {
    // A file written by a newer build may carry ids this one has never heard
    // of; that must not reject the whole patch — toPatch degrades them.
    expect(isStoredPatch({ ...valid, styleVariant: 'bold', icon: 'amp', texture: 'tolex' })).toBe(
      true,
    );
    expect(isStoredPatch({ ...valid, icon: 'hologram' })).toBe(true);
    expect(isStoredPatch({ ...valid, styleVariant: 3 })).toBe(false);
    expect(isStoredPatch({ ...valid, texture: ['tolex'] })).toBe(false);
  });

  it('accepts a drawer category, and only as a string', () => {
    expect(isStoredPatch({ ...valid, category: 'Amps' })).toBe(true);
    expect(isStoredPatch({ ...valid, category: 7 })).toBe(false);
    expect(isStoredPatch({ ...valid, category: ['Amps'] })).toBe(false);
  });

  it('rejects anything that would apply an empty or foreign-shaped tone', () => {
    expect(isStoredPatch({ ...valid, state: '' })).toBe(false);
    expect(isStoredPatch({ ...valid, state: 42 })).toBe(false);
    expect(isStoredPatch({ ...valid, pluginVersion: 3 })).toBe(false);
    expect(isStoredPatch({ ...valid, pluginName: undefined })).toBe(false);
    expect(isStoredPatch({ ...valid, knobs: [{ paramIndex: 'one', label: 'Gain' }] })).toBe(false);
    expect(isStoredPatch(null)).toBe(false);
  });

  it('rejects the index older builds wrote, so a stale one cannot load as a patch', () => {
    expect(isStoredPatch([{ id: 'p1', name: 'Lead', pluginName: 'Mock Amp', knobs: [] }])).toBe(
      false,
    );
  });
});

describe('patchTitleOverride', () => {
  const tone = {
    toneId: 42,
    modelId: 7,
    title: '1997 Match Brave Hi',
    gear: 'amp-cab',
    format: 'nam',
    creator: { username: 'someone' },
    file: 'nam/42-7.nam',
  };

  it('asks for nothing when the patch carries no title of its own', () => {
    expect(patchTitleOverride(toPatch('p1', stored('Lead')))).toBeUndefined();
  });

  it('asks for the saved override on an ordinary patch', () => {
    expect(patchTitleOverride(toPatch('p1', { ...stored('Lead'), displayName: 'Lead Amp' }))).toBe(
      'Lead Amp',
    );
  });

  it('names a TONE3000 card after its tone, not after the card it was captured on', () => {
    // The download writes no displayName, but patches written before that rule
    // carry the previous tone's — the card would otherwise wear the name of the
    // first tone ever loaded onto it, whatever it is playing now.
    const patch = toPatch('p1', {
      ...stored('1997 Match Brave Hi'),
      displayName: 'Bogner Uberschall Rev Blue (E34L)',
      tone3000: tone,
    });
    expect(patchTitleOverride(patch)).toBe('1997 Match Brave Hi');
  });
});

describe('toPatch', () => {
  it('takes the id from the file name and leaves the tone on disk', () => {
    const patch = toPatch('p1', { ...stored('Lead'), state: 'YmxvYg==' });
    expect(patch).toEqual({ id: 'p1', name: 'Lead', pluginName: 'Mock Amp', knobs: [] });
  });

  it('brings the card’s look along, since loading applies it with the mapping', () => {
    const patch = toPatch('p1', {
      ...stored('Lead'),
      displayName: 'Lead Amp',
      color: '#c04a2b',
      styleVariant: 'outline',
      icon: 'drive',
      texture: 'metal',
    });
    expect(patch.displayName).toBe('Lead Amp');
    expect(patch.color).toBe('#c04a2b');
    expect(patch.styleVariant).toBe('outline');
    expect(patch.icon).toBe('drive');
    expect(patch.texture).toBe('metal');
  });

  it('degrades a style id it does not know to the default look', () => {
    // The permissive isStoredPatch let the document in; the unknown id ends
    // here, as "no icon", instead of ever reaching a class name.
    const patch = toPatch('p1', {
      ...stored('Lead'),
      styleVariant: 'neon',
      icon: 'hologram',
      texture: 'velvet',
    } as never);
    expect(patch.styleVariant).toBeUndefined();
    expect(patch.icon).toBeUndefined();
    expect(patch.texture).toBeUndefined();
  });

  it('carries the drawer category, which files the patch in the drawer', () => {
    expect(toPatch('p1', { ...stored('Lead'), category: 'Amps' }).category).toBe('Amps');
    expect(toPatch('p1', stored('Lead')).category).toBeUndefined();
  });

  it('marks a pack’s patches read-only', () => {
    expect(toPatch('amps_jtm45', stored('JTM45'), true).readOnly).toBe(true);
    expect('readOnly' in toPatch('p1', stored('Lead'))).toBe(false);
  });

  it('cannot collide with a user patch, since the file name carries the pack', () => {
    expect(toPatch('amps_jtm45', stored('JTM45'), true).id).not.toBe('jtm45');
  });
});

describe('byName', () => {
  const p = (id: string, name: string): Patch => ({ id, name, pluginName: 'Mock Amp', knobs: [] });

  it('orders by name, then by id so two of a name stay put', () => {
    expect(
      [p('b', 'Rhythm'), p('c', 'Lead'), p('a', 'Lead')].sort(byName).map((x) => x.id),
    ).toEqual(['a', 'c', 'b']);
  });
});

describe('mergePatches', () => {
  const p = (id: string): Patch => ({ id, name: id, pluginName: 'Mock Amp', knobs: [] });

  it('lists the user’s own first, then installed ones', () => {
    expect(mergePatches([p('mine')], [toPatch('amps_jtm45', stored('JTM45'), true)])).toHaveLength(
      2,
    );
    expect(mergePatches([p('mine')], []).map((x) => x.id)).toEqual(['mine']);
  });

  it('leaves the user list untouched, so persisting cannot pick up a pack', () => {
    const user = [p('mine')];
    mergePatches(user, [toPatch('amps_jtm45', stored('JTM45'), true)]);
    expect(user).toEqual([p('mine')]);
  });
});
