import { describe, expect, it } from 'vitest';
import {
  buildDrawerTree,
  firstSectionWith,
  isTone3000Root,
  isUncategorised,
  NO_SECTION,
  resolveOpenKey,
  type DrawerTree,
} from './drawerTree';
import { patchSectionKey } from '../../lib/engine/drawerGroups';
import type { CataloguePackage } from '../../lib/engine/catalogue';
import type { Patch, PluginInfo } from '../../lib/engine/types';

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

/** The usual call: patches and plugins, no packages, no filter. */
const build = (input: {
  patches?: Patch[];
  plugins?: PluginInfo[];
  packages?: CataloguePackage[];
  filter?: string;
}): DrawerTree =>
  buildDrawerTree({
    patches: input.patches ?? [],
    plugins: input.plugins ?? [],
    packages: input.packages ?? [],
    filter: input.filter ?? '',
  });

const titles = (tree: DrawerTree) => tree.treeRoots.map((n) => n.title);

describe('buildDrawerTree — the patch tree', () => {
  it('nests a path into a parent row with a child row', () => {
    const tree = build({ patches: [patch({ id: 'a', category: 'Effects / Reverb' })] });

    expect(titles(tree)).toEqual(['Effects']);
    const [effects] = tree.treeRoots;
    expect(effects.children.map((c) => c.title)).toEqual(['Reverb']);
    expect(effects.label).toBe('Effects');
    expect(effects.children[0].label).toBe('Effects / Reverb');
  });

  it('counts the whole subtree, not the node’s own entries', () => {
    const tree = build({
      patches: [
        patch({ id: 'a', category: 'Effects' }),
        patch({ id: 'b', category: 'Effects / Reverb' }),
        patch({ id: 'c', category: 'Effects / Reverb' }),
      ],
    });

    const [effects] = tree.treeRoots;
    // One of its own plus the two under Reverb.
    expect(effects.entries).toHaveLength(1);
    expect(effects.count).toBe(3);
    expect(effects.children[0].count).toBe(2);
  });

  it('keys a node exactly as patchSectionKey does, so the drawer and a patch menu agree', () => {
    const tree = build({ patches: [patch({ id: 'a', category: 'Effects / Reverb' })] });

    expect(tree.treeRoots[0].key).toBe(patchSectionKey(['Effects']));
    expect(tree.treeRoots[0].children[0].key).toBe(patchSectionKey(['Effects', 'Reverb']));
  });

  it('holds the drawer’s fixed reading order: TONE3000, Effects, catalogue, then the user’s', () => {
    const tree = build({
      patches: [
        patch({ id: 'z', category: 'Zed' }),
        patch({ id: 'c', category: 'Cabs & IRs' }),
        patch({ id: 'e', category: 'Effects' }),
        patch({ id: 't', category: 'TONE3000' }),
      ],
      packages: [pkg({ id: 'irs', category: ['Cabs & IRs'] })],
    });

    expect(titles(tree)).toEqual(['TONE3000', 'Effects', 'Cabs & IRs', 'Zed']);
  });
});

describe('buildDrawerTree — the uncategorised row', () => {
  it('hoists the uncategorised root out of the tree', () => {
    const tree = build({ patches: [patch({ id: 'a' }), patch({ id: 'b', category: 'Effects' })] });

    expect(tree.uncategorised?.entries.map((e) => e.patch.id)).toEqual(['a']);
    expect(titles(tree)).toEqual(['Effects']);
  });

  it('leaves its children as ordinary roots at the end of the list', () => {
    const tree = build({
      patches: [
        patch({ id: 'a' }),
        patch({ id: 'b', category: 'Uncategorised / Odds' }),
        patch({ id: 'c', category: 'Effects' }),
      ],
    });

    expect(tree.uncategorised?.entries.map((e) => e.patch.id)).toEqual(['a']);
    expect(titles(tree)).toEqual(['Effects', 'Odds']);
  });

  it('merges a hand-typed lower-case heading into the fallback', () => {
    const tree = build({
      patches: [patch({ id: 'a' }), patch({ id: 'b', category: 'uncategorised' })],
    });

    expect(tree.uncategorised?.count).toBe(2);
    expect(tree.treeRoots).toHaveLength(0);
  });

  it('is undefined when every patch is filed', () => {
    const tree = build({ patches: [patch({ id: 'a', category: 'Effects' })] });

    expect(tree.uncategorised).toBeUndefined();
  });
});

describe('buildDrawerTree — the plugins section', () => {
  it('counts every maker bucket', () => {
    const tree = build({
      plugins: [
        plugin({ id: 'p1', manufacturer: 'Acme' }),
        plugin({ id: 'p2', manufacturer: 'Acme' }),
        plugin({ id: 'p3', manufacturer: 'Beta' }),
        plugin({ id: 'p4', manufacturer: 'Beta' }),
      ],
    });

    expect(tree.pluginsSection?.count).toBe(4);
    expect(tree.pluginsSection?.groups).toHaveLength(2);
  });

  it('is absent when no plugins are installed', () => {
    expect(build({}).pluginsSection).toBeUndefined();
  });
});

describe('buildDrawerTree — allSections', () => {
  it('reads uncategorised first, then depth-first parent-before-child, then plugins', () => {
    const tree = build({
      patches: [
        patch({ id: 'a' }),
        patch({ id: 'b', category: 'Effects' }),
        patch({ id: 'c', category: 'Effects / Reverb' }),
      ],
      plugins: [plugin({ id: 'p1', manufacturer: 'Acme' })],
    });

    expect(tree.allSections.map((s) => s.key)).toEqual([
      patchSectionKey(['Uncategorised']),
      patchSectionKey(['Effects']),
      patchSectionKey(['Effects', 'Reverb']),
      'plugins',
    ]);
  });

  it('is empty when there is nothing at all — what the empty state asks', () => {
    expect(build({}).allSections).toHaveLength(0);
  });
});

describe('buildDrawerTree — the filter', () => {
  const patches = [
    patch({ id: 'a', name: 'Crunch', pluginName: 'Mock Amp', category: 'Effects' }),
    patch({ id: 'b', name: 'Clean', displayName: 'Glassy', pluginName: 'Other Amp' }),
  ];
  const plugins = [
    plugin({ id: 'p1', name: 'Archetype', manufacturer: 'Neural DSP' }),
    plugin({ id: 'p2', name: 'Valhalla', manufacturer: 'Valhalla' }),
  ];

  const ids = (tree: DrawerTree) =>
    tree.allSections.flatMap((s) => (s.kind === 'patches' ? s.entries.map((e) => e.patch.id) : []));

  it('matches a patch on its own name', () => {
    expect(ids(build({ patches, filter: 'crunch' }))).toEqual(['a']);
  });

  it('matches a patch on its display name', () => {
    expect(ids(build({ patches, filter: 'glassy' }))).toEqual(['b']);
  });

  it('matches a patch on its plugin', () => {
    expect(ids(build({ patches, filter: 'other amp' }))).toEqual(['b']);
  });

  it('matches a patch on its heading', () => {
    expect(ids(build({ patches, filter: 'effects' }))).toEqual(['a']);
  });

  it('matches a plugin on its vendor, not only its own name', () => {
    const tree = build({ plugins, filter: 'neural' });
    expect(tree.pluginsSection?.groups.flatMap(([, p]) => p.map((x) => x.id))).toEqual(['p1']);
  });

  it('leaves nothing standing when it matches nothing', () => {
    const tree = build({ patches, plugins, filter: 'zzz' });
    expect(tree.uncategorised).toBeUndefined();
    expect(tree.treeRoots).toHaveLength(0);
    expect(tree.pluginsSection).toBeUndefined();
  });

  it('ignores surrounding whitespace', () => {
    expect(ids(build({ patches, filter: '  crunch  ' }))).toEqual(['a']);
  });
});

describe('resolveOpenKey', () => {
  const tree = build({
    patches: [patch({ id: 'a' }), patch({ id: 'b', category: 'Effects' })],
    plugins: [plugin({ id: 'p1', manufacturer: 'Acme' })],
  });

  it('opens nothing for the all-closed state', () => {
    expect(resolveOpenKey(NO_SECTION, tree)).toBeUndefined();
  });

  it('keeps a key that still names a section', () => {
    expect(resolveOpenKey(patchSectionKey(['Effects']), tree)).toBe(patchSectionKey(['Effects']));
  });

  // The uncategorised row is allSections[0] and has no header to open, so the
  // fallback must reach past it to the first real section.
  it('falls back to the first section, not the uncategorised row', () => {
    expect(resolveOpenKey('patches:Gone', tree)).toBe(patchSectionKey(['Effects']));
  });

  it('falls back to the plugins section when there are no patch roots', () => {
    const noRoots = build({
      patches: [patch({ id: 'a' })],
      plugins: [plugin({ id: 'p1', manufacturer: 'Acme' })],
    });
    expect(resolveOpenKey('patches:Gone', noRoots)).toBe('plugins');
  });

  it('has nothing to fall back to in an empty drawer', () => {
    expect(resolveOpenKey('patches:Gone', build({}))).toBeUndefined();
  });
});

describe('isUncategorised', () => {
  it('matches the fallback heading whatever its casing', () => {
    expect(isUncategorised({ key: patchSectionKey(['Uncategorised']) })).toBe(true);
    expect(isUncategorised({ key: 'patches:uncategorised' })).toBe(true);
    expect(isUncategorised({ key: patchSectionKey(['Effects']) })).toBe(false);
  });
});

describe('isTone3000Root', () => {
  const tree = build({
    patches: [
      patch({ id: 'a', category: 'TONE3000' }),
      patch({ id: 'b', category: 'TONE3000 / Pedal' }),
      patch({ id: 'c', category: 'tone3000' }),
    ],
    plugins: [plugin({ id: 'p1', manufacturer: 'Acme' })],
  });
  const root = tree.treeRoots[0];

  it('titles the root with the wordmark', () => {
    expect(isTone3000Root(root, 0)).toBe(true);
  });

  it('leaves the subsections as text', () => {
    expect(isTone3000Root(root.children[0], 1)).toBe(false);
  });

  it('is case-folded, like the grouping that merged the heading', () => {
    // The lower-case heading merged into the same root, which is still titled
    // by the logo.
    expect(root.count).toBe(3);
  });

  it('is never the plugins section', () => {
    expect(isTone3000Root(tree.pluginsSection!, 0)).toBe(false);
  });
});

describe('firstSectionWith', () => {
  const tree = build({
    patches: [
      patch({ id: 'a' }),
      patch({ id: 'b', category: 'Effects' }),
      patch({ id: 'c', category: 'Effects / Reverb' }),
    ],
    plugins: [plugin({ id: 'p1', manufacturer: 'Acme' })],
  });

  it('finds a tile in the uncategorised row', () => {
    expect(firstSectionWith(tree.allSections, new Set(['a']))?.key).toBe(
      patchSectionKey(['Uncategorised']),
    );
  });

  it('finds a tile in a nested section', () => {
    expect(firstSectionWith(tree.allSections, new Set(['c']))?.key).toBe(
      patchSectionKey(['Effects', 'Reverb']),
    );
  });

  it('finds a plugin by its id', () => {
    expect(firstSectionWith(tree.allSections, new Set(['p1']))?.key).toBe('plugins');
  });

  it('returns the first in display order when several match', () => {
    expect(firstSectionWith(tree.allSections, new Set(['c', 'b']))?.key).toBe(
      patchSectionKey(['Effects']),
    );
  });

  it('finds nothing for an unknown id', () => {
    expect(firstSectionWith(tree.allSections, new Set(['nope']))).toBeUndefined();
  });
});
