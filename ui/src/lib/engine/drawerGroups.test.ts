import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PATH_SEPARATOR,
  DRAWER_UNCATEGORISED,
  patchGroups,
  UNKNOWN_MAKER,
  groupPatches,
  groupPluginsByMaker,
  isSectionOnBranch,
  orderPatchEntries,
  packageDrawerItems,
  packageIdForPatch,
  parentSectionKey,
  patchCategory,
  patchSectionKey,
  splitCategoryPath,
} from './drawerGroups';
import type { CataloguePackage } from './catalogue';
import type { Patch, PluginInfo } from './types';

const patch = (over: Partial<Patch> & { id: string }): Patch => ({
  name: over.id,
  pluginName: 'Mock Amp',
  knobs: [],
  ...over,
});

const pkg = (over: Partial<CataloguePackage> & { id: string }): CataloguePackage => ({
  kind: 'content',
  category: [],
  tags: [],
  name: over.id,
  purpose: '',
  version: '1.0',
  licenseId: 'MIT',
  licenseUrl: '',
  projectUrl: '',
  downloadBytes: 0,
  selfHosted: false,
  installed: true,
  installedVersion: '1.0',
  updateAvailable: false,
  available: true,
  unlisted: false,
  dir: '',
  dependsOn: '',
  ...over,
});

const plugin = (over: Partial<PluginInfo> & { id: string }): PluginInfo => ({
  name: over.id,
  ...over,
});

describe('packageDrawerItems', () => {
  it('finds the plugins a package registered', () => {
    const items = packageDrawerItems(
      'surge-xt',
      [],
      [
        plugin({ id: 'p1', packageId: 'surge-xt' }),
        plugin({ id: 'p2', packageId: 'surge-xt' }),
        plugin({ id: 'p3', packageId: 'zam-plugins' }),
        plugin({ id: 'p4' }),
      ],
    );
    expect(items).toEqual({ patchIds: [], pluginIds: ['p1', 'p2'] });
  });

  it('finds a pack patch by its folder name, exactly or prefixed', () => {
    const items = packageDrawerItems(
      'amalgam-jtm45',
      [
        patch({ id: 'amalgam-jtm45', readOnly: true }),
        patch({ id: 'amalgam-jtm45_clean', readOnly: true }),
        patch({ id: 'amalgam-plexi', readOnly: true }),
      ],
      [],
    );
    expect(items.patchIds).toEqual(['amalgam-jtm45', 'amalgam-jtm45_clean']);
  });

  it("leaves the user's own patches alone, whatever they are called", () => {
    const items = packageDrawerItems('amalgam-jtm45', [patch({ id: 'amalgam-jtm45_mine' })], []);
    expect(items.patchIds).toEqual([]);
  });

  it('reports nothing for a package the drawer cannot show', () => {
    const items = packageDrawerItems(
      'cab-irs',
      [patch({ id: 'mine' })],
      [plugin({ id: 'p1', packageId: 'surge-xt' })],
    );
    expect(items).toEqual({ patchIds: [], pluginIds: [] });
  });
});

describe('packageIdForPatch', () => {
  const packs = [
    pkg({ id: 'amalgam-jtm45' }),
    pkg({ id: 'dragonfly-reverb-patches' }),
    pkg({ id: 'dragonfly-reverb', kind: 'plugin' }),
  ];

  it('names the package a pack patch was installed with', () => {
    expect(packageIdForPatch(patch({ id: 'amalgam-jtm45', readOnly: true }), packs)).toBe(
      'amalgam-jtm45',
    );
  });

  it('joins a multi-patch pack by its folder prefix', () => {
    const p = patch({ id: 'dragonfly-reverb-patches_hall', readOnly: true });
    expect(packageIdForPatch(p, packs)).toBe('dragonfly-reverb-patches');
  });

  it('does not let a shorter package id claim a longer one’s patch', () => {
    // 'dragonfly-reverb' is a prefix of the pack's id but not of a patch
    // folder: the join is on '<id>_', so only the patches package matches.
    const p = patch({ id: 'dragonfly-reverb-patches_hall', readOnly: true });
    expect(packageIdForPatch(p, packs)).not.toBe('dragonfly-reverb');
  });

  it('claims nothing for a patch the user saved themselves', () => {
    // Same id as a package, deliberately: a patch of the user's own is theirs
    // however its file happens to be named, so the badge is not offered.
    expect(packageIdForPatch(patch({ id: 'amalgam-jtm45' }), packs)).toBeUndefined();
  });

  it('is undefined for a pack whose package the catalogue no longer lists', () => {
    expect(
      packageIdForPatch(patch({ id: 'withdrawn-pack', readOnly: true }), packs),
    ).toBeUndefined();
  });
});

describe('patchCategory', () => {
  it('reads a separator-joined category as a nested path', () => {
    expect(patchCategory(patch({ id: 'a', category: 'TONE3000 / Pedal' }))).toEqual([
      'TONE3000',
      'Pedal',
    ]);
  });

  it('leaves a pack patch uncategorised when its document names no heading', () => {
    // Nothing is inherited from the package that installed it: a pack files
    // its patches by writing `category` into patch.json like anyone else.
    const p = patch({ id: 'amalgam-jtm45', readOnly: true });
    expect(patchCategory(p)).toEqual([DRAWER_UNCATEGORISED]);
  });

  it('files a pack patch under the heading its own document names', () => {
    const p = patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Amps' });
    expect(patchCategory(p)).toEqual(['Amps']);
  });

  it('leaves a user patch uncategorised, not filed under its plugin’s package', () => {
    const p = patch({ id: 'p1', pluginName: 'Dragonfly Hall' });
    expect(patchCategory(p)).toEqual([DRAWER_UNCATEGORISED]);
  });

  it('falls back to uncategorised when nothing can name a heading', () => {
    expect(patchCategory(patch({ id: 'p1' }))).toEqual([DRAWER_UNCATEGORISED]);
  });

  it('treats a blank heading as unset rather than as a nameless section', () => {
    const p = patch({ id: 'amalgam-jtm45', readOnly: true, category: '  ' });
    expect(patchCategory(p)).toEqual([DRAWER_UNCATEGORISED]);
  });
});

describe('groupPatches', () => {
  const packages = [
    pkg({ id: 'amalgam-jtm45', category: ['Amps'] }),
    pkg({ id: 'dragonfly-reverb', kind: 'plugin', category: ['Effects', 'Reverb'] }),
  ];

  it('orders roots by the drawer rule: Effects before the other catalogue headings, uncategorised last', () => {
    const roots = groupPatches(
      [
        patch({ id: 'loose' }),
        patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Amps' }),
        patch({ id: 'dragonfly-reverb', readOnly: true, category: 'Effects / Reverb' }),
      ],
      packages,
    );
    expect(roots.map((n) => n.category)).toEqual(['Effects', 'Amps', DRAWER_UNCATEGORISED]);
  });

  it('pins TONE3000 first and files user headings behind the catalogue ones', () => {
    const roots = groupPatches(
      [
        patch({ id: 'mine', category: 'My Board' }),
        patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Amps' }),
        patch({ id: 'dragonfly-reverb', readOnly: true, category: 'Effects / Reverb' }),
        patch({
          id: 'tone',
          pluginName: 'NeuralAmpModeler',
          tone3000: {
            toneId: 1,
            modelId: 2,
            format: 'nam',
            gear: 'amp',
            title: 'JCM',
            creator: { username: 'akka5' },
            file: 'nam/1-2.nam',
          },
        }),
      ],
      packages,
    );
    expect(roots.map((n) => n.category)).toEqual(['TONE3000', 'Effects', 'Amps', 'My Board']);
  });

  it('nests a path the same way the packages panel does', () => {
    const roots = groupPatches(
      [patch({ id: 'dragonfly-reverb', readOnly: true, category: 'Effects / Reverb' })],
      packages,
    );
    expect(roots[0].category).toBe('Effects');
    expect(roots[0].children[0].category).toBe('Reverb');
    expect(roots[0].children[0].entries[0].patch.id).toBe('dragonfly-reverb');
  });

  it('merges a user heading with a catalogue one of the same name', () => {
    const roots = groupPatches(
      [
        patch({ id: 'mine', category: 'Amps' }),
        patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Amps' }),
      ],
      packages,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0].entries.map((e) => e.patch.id)).toEqual(['mine', 'amalgam-jtm45']);
  });

  it('merges and pins case-insensitively: a hand-typed "effects" is the Effects section', () => {
    const roots = groupPatches(
      [
        patch({ id: 'mine', category: 'effects / Fuzz' }),
        patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Amps' }),
      ],
      packages,
    );
    expect(roots.map((n) => n.category)).toEqual(['effects', 'Amps']);
    expect(roots[0].children.map((n) => n.category)).toEqual(['Fuzz']);
  });
});

describe('patchGroups', () => {
  const packages = [
    pkg({ id: 'dragonfly-reverb', kind: 'plugin', category: ['Effects', 'Reverb'] }),
  ];

  it('flattens the tree depth-first, a parent above its subsections', () => {
    const groups = patchGroups(
      [
        patch({ id: 'hall', category: `Effects${CATEGORY_PATH_SEPARATOR}Reverb` }),
        patch({ id: 'multi', category: 'Effects' }),
        patch({ id: 'loose' }),
      ],
      packages,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Effects',
      `Effects${CATEGORY_PATH_SEPARATOR}Reverb`,
      DRAWER_UNCATEGORISED,
    ]);
  });

  it('applies the drawer’s hand order inside a heading, keyed as the drawer keys it', () => {
    const patches = [patch({ id: 'a', category: 'Amps' }), patch({ id: 'b', category: 'Amps' })];
    const [section] = patchGroups(patches, []);
    const reordered = patchGroups(patches, [], { [section.key]: ['b'] });
    expect(reordered[0].entries.map((e) => e.patch.id)).toEqual(['b', 'a']);
  });
});

describe('section keys', () => {
  it('names a heading path, nested or not', () => {
    expect(patchSectionKey(['Amps'])).toBe('patches:Amps');
    expect(patchSectionKey(['TONE3000', 'Pedal', 'S'])).toBe('patches:TONE3000/Pedal/S');
  });

  it('walks one level up, and stops at a root', () => {
    expect(parentSectionKey(['TONE3000', 'Pedal', 'S'])).toBe('patches:TONE3000/Pedal');
    expect(parentSectionKey(['Amps'])).toBeUndefined();
  });

  it('holds every ancestor of the open heading open', () => {
    const open = patchSectionKey(['TONE3000', 'Pedal', 'S']);
    expect(isSectionOnBranch(patchSectionKey(['TONE3000']), open)).toBe(true);
    expect(isSectionOnBranch(patchSectionKey(['TONE3000', 'Pedal']), open)).toBe(true);
    expect(isSectionOnBranch(open, open)).toBe(true);
  });

  it('leaves a sibling, a descendant and a same-prefixed heading closed', () => {
    const open = patchSectionKey(['TONE3000', 'Pedal']);
    expect(isSectionOnBranch(patchSectionKey(['TONE3000', 'Amp + Cab']), open)).toBe(false);
    expect(isSectionOnBranch(patchSectionKey(['TONE3000', 'Pedal', 'S']), open)).toBe(false);
    // The separator is what stops "Pedal" from claiming "Pedals".
    expect(isSectionOnBranch(patchSectionKey(['TONE3000', 'Pedals']), open)).toBe(false);
    expect(isSectionOnBranch('plugins', open)).toBe(false);
  });

  it('is the key flattenPatchGroups mints, so the drawer and a patch menu agree', () => {
    const groups = patchGroups([patch({ id: 'a', category: 'Effects / Reverb' })], []);
    expect(groups.map((g) => g.key)).toContain(patchSectionKey(['Effects', 'Reverb']));
  });
});

describe('splitCategoryPath', () => {
  it('reads a stored category as a heading path', () => {
    expect(splitCategoryPath('Pedal')).toEqual(['Pedal']);
    expect(splitCategoryPath('TONE3000 / Pedal')).toEqual(['TONE3000', 'Pedal']);
  });

  it('splits on a slash however it was spaced', () => {
    expect(splitCategoryPath('Test/Sub')).toEqual(['Test', 'Sub']);
    expect(splitCategoryPath('AA /SS')).toEqual(['AA', 'SS']);
  });

  it('still reads a category stored under the old " · " separator', () => {
    expect(splitCategoryPath('TONE3000 · Pedal')).toEqual(['TONE3000', 'Pedal']);
  });

  it('drops empty segments so a stray separator names no blank heading', () => {
    expect(splitCategoryPath(' / Pedal')).toEqual(['Pedal']);
    expect(splitCategoryPath(' / ')).toEqual([]);
    expect(splitCategoryPath(' · ')).toEqual([]);
  });
});

describe('orderPatchEntries', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({ patch: patch({ id }), category: ['X'] }));
  const ids = (out: { patch: Patch }[]) => out.map((e) => e.patch.id);

  it('keeps the incoming order without a stored one', () => {
    expect(ids(orderPatchEntries(entries, undefined))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(orderPatchEntries(entries, []))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('puts ordered ids first and appends the rest in incoming order', () => {
    expect(ids(orderPatchEntries(entries, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('skips ids naming patches no longer in the section', () => {
    expect(ids(orderPatchEntries(entries, ['gone', 'd', 'b']))).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('groupPluginsByMaker', () => {
  it('buckets vendors A→Z with entries name-sorted', () => {
    const groups = groupPluginsByMaker([
      plugin({ id: 'b', name: 'Zeta', manufacturer: 'Valhalla' }),
      plugin({ id: 'a', name: 'Alpha', manufacturer: 'Valhalla' }),
      plugin({ id: 'c', name: 'Hall', manufacturer: 'Dragonfly' }),
      plugin({ id: 'd', name: 'Room', manufacturer: 'Dragonfly' }),
    ]);
    expect(groups.map(([maker]) => maker)).toEqual(['Dragonfly', 'Valhalla']);
    expect(groups[1][1].map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('merges single-plugin vendors and the vendorless into a trailing catch-all', () => {
    const groups = groupPluginsByMaker([
      plugin({ id: 'a', name: 'Solo', manufacturer: 'One Hit' }),
      plugin({ id: 'b', name: 'Anon' }),
      plugin({ id: 'c', name: 'Hall', manufacturer: 'Dragonfly' }),
      plugin({ id: 'd', name: 'Room', manufacturer: 'Dragonfly' }),
    ]);
    expect(groups.map(([maker]) => maker)).toEqual(['Dragonfly', UNKNOWN_MAKER]);
    expect(groups[1][1].map((p) => p.name)).toEqual(['Anon', 'Solo']);
  });

  it('treats a whitespace manufacturer as none', () => {
    const groups = groupPluginsByMaker([plugin({ id: 'a', name: 'Anon', manufacturer: '  ' })]);
    expect(groups).toEqual([[UNKNOWN_MAKER, [expect.objectContaining({ name: 'Anon' })]]]);
  });
});
