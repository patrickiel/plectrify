import {
  CATEGORY_PATH_SEPARATOR,
  DRAWER_UNCATEGORISED,
  groupPatches,
  groupPluginsByMaker,
  patchSectionKey,
  type DrawerPatch,
} from '../../lib/engine/drawerGroups';
import type { CataloguePackage, CategoryNode } from '../../lib/engine/catalogue';
import type { Patch, PluginInfo } from '../../lib/engine/types';
import { TONE3000_HEADING } from '../../lib/engine/tone3000';

/**
 * The shape the module drawer draws: one filtered tree of patch headings, the
 * plugins section, and the flat view of both that the reveal, the reorder
 * lookup and the stale-key resolution walk.
 *
 * Pure over the lists the drawer already holds — the same doctrine
 * `drawerGroups.ts` states for the grouping it composes: the component stays
 * presentation, and the pruning, the counting and the open-key fallback stay
 * testable.
 */

/** One row of the drawer's tree: a patch category node — its own tiles plus
    its subsections, every level an expandable row of its own. A node's `key`
    and `label` name it exactly as the flat list always did (the open section
    and the hand order persist under the key; the refile drop writes the label
    back as the category), so nesting the display changed nothing stored. */
export type PatchNode = {
  kind: 'patches';
  key: string;
  /** The whole path as one string — what a refile writes back as the
      category, and what `splitCategoryPath` reads again as a path. */
  label: string;
  /** The last segment alone — what the row prints. */
  title: string;
  path: string[];
  entries: DrawerPatch[];
  children: PatchNode[];
  /** Entries in the whole subtree — what the row's count shows. */
  count: number;
};

/** The single Plugins section, whose maker buckets render as fixed
    sub-headings inside it rather than as sections of their own — a dozen
    collapsed vendor rows told nothing about what was installed, where one open
    list under one heading shows all of it. */
export type PluginsSection = {
  kind: 'plugins';
  key: 'plugins';
  label: string;
  title: string;
  groups: [string, PluginInfo[]][];
  /** Plugins across every bucket — the same number the row's count shows. */
  count: number;
};

export type DrawerSection = PatchNode | PluginsSection;

export interface DrawerTree {
  /** The Uncategorised patches are the special case: no heading and no
      accordion — their tiles sit resolved at the very top of the list, above
      the sections, so a freshly saved patch is in sight rather than filed
      under a label that only says it was not filed. Still a section object
      underneath, so the reorder and refile gestures work on it unchanged. */
  uncategorised: PatchNode | undefined;
  /** The tree the accordion draws, the uncategorised root pulled out to the
      top row — its children (a heading typed as "Uncategorised / X") stay
      ordinary sections at the end of the list. */
  treeRoots: PatchNode[];
  pluginsSection: PluginsSection | undefined;
  /** Every section in display order, tree flattened depth-first. */
  allSections: DrawerSection[];
}

/** The all-closed state's stored form, unmistakable for a real key because
    every key carries a `patches:`/`plugins:` prefix. */
export const NO_SECTION = 'none';

/** The one key that names no path. */
const PLUGINS_KEY = 'plugins';

// Case-folded like the grouping: a hand-typed "uncategorised" heading merges
// with the fallback under whichever casing was seen first.
const UNCATEGORISED_KEY = `patches:${DRAWER_UNCATEGORISED}`.toLowerCase();

export function isUncategorised(section: { key: string }): boolean {
  return section.key.toLowerCase() === UNCATEGORISED_KEY;
}

/** The one heading that is a logo rather than a word.
 *
 * TONE3000's wordmark is how their section is named everywhere else they
 * appear (the browse tile above it, the partnership splash), and typing
 * their name in the drawer's own uppercase is the one place it was not.
 * Root only — the subsections under it ("Amp + Cab", "Pedal") are ours and
 * stay text — and case-folded like the grouping, so a hand-typed
 * "tone3000" heading, which merges into this section, is titled by it too. */
export function isTone3000Root(section: DrawerSection, depth: number): boolean {
  if (section.kind !== 'patches' || depth !== 0) return false;
  return section.path[0]?.toLowerCase() === TONE3000_HEADING.toLowerCase();
}

function toPatchNode(node: CategoryNode<DrawerPatch>): PatchNode {
  // Empty branches are pruned as flattenPatchGroups dropped them: a heading
  // with nothing anywhere under it is not a row.
  const children = node.children.map(toPatchNode).filter((child) => child.count > 0);
  return {
    kind: 'patches',
    // The same keys flattenPatchGroups mints, so the drawer and a module's
    // patch menu agree on the hand order stored under them.
    key: patchSectionKey(node.path),
    label: node.path.join(CATEGORY_PATH_SEPARATOR),
    title: node.path[node.path.length - 1] ?? '',
    path: node.path,
    entries: node.entries,
    children,
    count: node.entries.length + children.reduce((n, child) => n + child.count, 0),
  };
}

function flattenNodes(nodes: readonly PatchNode[], out: PatchNode[] = []): PatchNode[] {
  for (const node of nodes) {
    out.push(node);
    flattenNodes(node.children, out);
  }
  return out;
}

// One filter over both kinds: a patch matches on its own name, its plugin
// or its heading; a plugin matches on its name or vendor (as the old picker
// did — "neural" should find the Archetypes even though none of them carry
// the maker's name in their own).
function matchPatch(patch: Patch, q: string): boolean {
  return [patch.name, patch.displayName ?? '', patch.pluginName, patch.category ?? ''].some((s) =>
    s.toLowerCase().includes(q),
  );
}

function matchPlugin(plugin: PluginInfo, q: string): boolean {
  return (
    plugin.name.toLowerCase().includes(q) || (plugin.manufacturer ?? '').toLowerCase().includes(q)
  );
}

/** The drawer's whole tree for one set of lists and one filter string. */
export function buildDrawerTree(input: {
  patches: readonly Patch[];
  plugins: readonly PluginInfo[];
  packages: readonly CataloguePackage[];
  filter: string;
}): DrawerTree {
  const q = input.filter.trim().toLowerCase();
  const patches = q ? input.patches.filter((p) => matchPatch(p, q)) : input.patches;
  const plugins = q ? input.plugins.filter((p) => matchPlugin(p, q)) : input.plugins;

  const roots = groupPatches(patches, input.packages)
    .map(toPatchNode)
    .filter((node) => node.count > 0);
  const uncategorised = roots.find((node) => isUncategorised(node));
  const rest = roots.filter((node) => !isUncategorised(node));
  const treeRoots = uncategorised ? [...rest, ...uncategorised.children] : rest;

  const groups = groupPluginsByMaker(plugins);
  const pluginsSection: PluginsSection | undefined =
    groups.length > 0
      ? {
          kind: 'plugins',
          key: PLUGINS_KEY,
          label: 'Plugins',
          title: 'Plugins',
          groups,
          count: groups.reduce((n, [, makerPlugins]) => n + makerPlugins.length, 0),
        }
      : undefined;

  const allSections: DrawerSection[] = flattenNodes(treeRoots);
  if (uncategorised) allSections.unshift(uncategorised);
  if (pluginsSection) allSections.push(pluginsSection);

  return { uncategorised, treeRoots, pluginsSection, allSections };
}

/** The open branch, resolved from the persisted key. The key names the deepest
    open node; its ancestors are open with it (see `isSectionOnBranch`), so the
    stored shape is still a single string. The resolution is derived rather
    than migrated — a key naming a section that no longer exists (plugins
    rescanned, category renamed) silently falls back to the first section
    without writing anything, and the stale value is overwritten on the next
    explicit click.

    The fallback is the first *section*, deliberately not `allSections[0]`:
    that is the uncategorised row, which has no header to open. */
export function resolveOpenKey(openSection: string, tree: DrawerTree): string | undefined {
  if (openSection === NO_SECTION) return undefined;
  return (
    tree.allSections.find((s) => s.key === openSection)?.key ??
    tree.treeRoots[0]?.key ??
    tree.pluginsSection?.key
  );
}

/** The first section holding one of these ids — the one the accordion
    opens for a reveal; a tile behind a collapsed heading is as good as
    absent. Searches the uncategorised row too: its tiles are always
    visible, so a hit there needs no section opened at all. */
export function firstSectionWith(
  sections: readonly DrawerSection[],
  ids: ReadonlySet<string>,
): DrawerSection | undefined {
  return sections.find((section) =>
    section.kind === 'patches'
      ? section.entries.some((entry) => ids.has(entry.patch.id))
      : section.groups.some(([, makerPlugins]) =>
          makerPlugins.some((plugin) => ids.has(plugin.id)),
        ),
  );
}
