import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PATH_SEPARATOR,
  DRAWER_UNCATEGORISED,
  patchGroups,
  UNKNOWN_MAKER,
  groupPatches,
  groupPluginsByMaker,
  orderPatchEntries,
  packageDrawerItems,
  patchCategory,
  pluginPackageIds,
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

describe('pluginPackageIds', () => {
  it('maps display names onto the packages that installed them', () => {
    const ids = pluginPackageIds([
      plugin({ id: 'a', name: 'NeuralAmpModeler', packageId: 'neural-amp-modeler' }),
      plugin({ id: 'b', name: 'Some Reverb' }),
    ]);
    expect(ids.get('NeuralAmpModeler')).toBe('neural-amp-modeler');
    expect(ids.has('Some Reverb')).toBe(false);
  });
});

describe('packageDrawerItems', () => {
  it('finds the plugins a package registered', () => {
    const items = packageDrawerItems(
      'surge-xt',
      [],
      [
        plugin({ id: 'p1', packageId: 'surge-xt' }),
        plugin({ id: 'p2', packageId: 'surge-xt' }),
        plugin({ id: 'p3', packageId: 'airwindows' }),
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

describe('patchCategory', () => {
  it('reads a separator-joined user category as a nested path', () => {
    expect(patchCategory(patch({ id: 'a', category: 'TONE3000 · Pedal' }), [], new Map())).toEqual([
      'TONE3000',
      'Pedal',
    ]);
  });

  const amps = pkg({ id: 'amalgam-jtm45', category: ['Amps'] });
  const reverb = pkg({ id: 'dragonfly-reverb', kind: 'plugin', category: ['Effects', 'Reverb'] });
  const packages = [amps, reverb];
  const byPlugin = new Map([['Dragonfly Hall', 'dragonfly-reverb']]);

  it('lets the user’s own heading override everything', () => {
    const p = patch({ id: 'amalgam-jtm45', readOnly: true, category: 'Favourites' });
    expect(patchCategory(p, packages, byPlugin)).toEqual(['Favourites']);
  });

  it('files a pack patch under its package’s heading', () => {
    const p = patch({ id: 'amalgam-jtm45', readOnly: true });
    expect(patchCategory(p, packages, byPlugin)).toEqual(['Amps']);
  });

  it('joins a multi-patch pack by the id prefix its folders carry', () => {
    const p = patch({ id: 'amalgam-jtm45_lead', readOnly: true });
    expect(patchCategory(p, packages, byPlugin)).toEqual(['Amps']);
  });

  it('files a user patch under the package its plugin came from', () => {
    const p = patch({ id: 'p1', pluginName: 'Dragonfly Hall' });
    expect(patchCategory(p, packages, byPlugin)).toEqual(['Effects', 'Reverb']);
  });

  it('falls back to uncategorised when nothing can name a heading', () => {
    expect(patchCategory(patch({ id: 'p1' }), packages, byPlugin)).toEqual([DRAWER_UNCATEGORISED]);
  });

  it('never returns an empty path, even for a package with no category', () => {
    const bare = [pkg({ id: 'bare-pack' })];
    const p = patch({ id: 'bare-pack', readOnly: true });
    expect(patchCategory(p, bare, new Map())).toEqual([DRAWER_UNCATEGORISED]);
  });

  it('treats a blank user heading as unset rather than as a nameless section', () => {
    const p = patch({ id: 'amalgam-jtm45', readOnly: true, category: '  ' });
    expect(patchCategory(p, packages, byPlugin)).toEqual(['Amps']);
  });
});

describe('groupPatches', () => {
  const packages = [
    pkg({ id: 'amalgam-jtm45', category: ['Amps'] }),
    pkg({ id: 'dragonfly-reverb', kind: 'plugin', category: ['Effects', 'Reverb'] }),
  ];
  const plugins = [
    plugin({ id: 'dh', name: 'Dragonfly Hall', packageId: 'dragonfly-reverb' }),
    plugin({ id: 'ma', name: 'Mock Amp' }),
  ];

  it('keeps heading order and moves uncategorised last', () => {
    const roots = groupPatches(
      [
        patch({ id: 'loose' }),
        patch({ id: 'amalgam-jtm45', readOnly: true }),
        patch({ id: 'hall', pluginName: 'Dragonfly Hall' }),
      ],
      packages,
      plugins,
    );
    expect(roots.map((n) => n.category)).toEqual(['Amps', 'Effects', DRAWER_UNCATEGORISED]);
  });

  it('nests a path the same way the packages panel does', () => {
    const roots = groupPatches([patch({ id: 'hall', pluginName: 'Dragonfly Hall' })], packages, [
      plugins[0],
    ]);
    expect(roots[0].category).toBe('Effects');
    expect(roots[0].children[0].category).toBe('Reverb');
    expect(roots[0].children[0].entries[0].patch.id).toBe('hall');
  });

  it('merges a user heading with a catalogue one of the same name', () => {
    const roots = groupPatches(
      [patch({ id: 'mine', category: 'Amps' }), patch({ id: 'amalgam-jtm45', readOnly: true })],
      packages,
      plugins,
    );
    expect(roots).toHaveLength(1);
    expect(roots[0].entries.map((e) => e.patch.id)).toEqual(['mine', 'amalgam-jtm45']);
  });
});

describe('patchGroups', () => {
  const packages = [
    pkg({ id: 'dragonfly-reverb', kind: 'plugin', category: ['Effects', 'Reverb'] }),
  ];
  const plugins = [plugin({ id: 'dh', name: 'Dragonfly Hall', packageId: 'dragonfly-reverb' })];

  it('flattens the tree depth-first, a parent above its subsections', () => {
    const groups = patchGroups(
      [
        patch({ id: 'hall', pluginName: 'Dragonfly Hall' }),
        patch({ id: 'multi', category: 'Effects' }),
        patch({ id: 'loose' }),
      ],
      packages,
      plugins,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Effects',
      `Effects${CATEGORY_PATH_SEPARATOR}Reverb`,
      DRAWER_UNCATEGORISED,
    ]);
  });

  it('applies the drawer’s hand order inside a heading, keyed as the drawer keys it', () => {
    const patches = [patch({ id: 'a', category: 'Amps' }), patch({ id: 'b', category: 'Amps' })];
    const [section] = patchGroups(patches, [], []);
    const reordered = patchGroups(patches, [], [], { [section.key]: ['b'] });
    expect(reordered[0].entries.map((e) => e.patch.id)).toEqual(['b', 'a']);
  });
});

describe('splitCategoryPath', () => {
  it('reads a stored category as a heading path', () => {
    expect(splitCategoryPath('Pedal')).toEqual(['Pedal']);
    expect(splitCategoryPath('TONE3000 · Pedal')).toEqual(['TONE3000', 'Pedal']);
  });

  it('drops empty segments so a stray separator names no blank heading', () => {
    expect(splitCategoryPath(' · Pedal')).toEqual(['Pedal']);
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
