import { TONE3000_HEADING, tone3000Category } from './tone3000';
import type { CataloguePackage, CategoryNode } from './catalogue';
import { groupByCategory } from './catalogue';
import type { Patch, PluginInfo } from './types';

/**
 * Grouping for the edit-mode module drawer: which heading a patch files under,
 * and how the plugin list buckets by manufacturer. Pure functions over the
 * lists the UI already holds — patches, plugins, catalogue — so the drawer
 * component stays presentation and this stays testable.
 */

/** The heading for patches no category can be derived for. Deliberately not
    `catalogue.UNCATEGORISED` ("More downloads") — that copy is about things
    still to be fetched, and everything in the drawer is already here. */
export const DRAWER_UNCATEGORISED = 'Uncategorised';

/** Manufacturer heading for plugins that report no vendor. Also absorbs
    single-plugin vendors, so a big plugin folder stays a short list of real
    groups instead of a column of one-item headings. Sorts last. */
export const UNKNOWN_MAKER = 'Other';

/** How a heading path reads (and is written) as one string: the same " / "
    the drawer prints between segments. A stored `Patch.category` containing
    it is a path — which is what lets a reorder drag dropped on a nested
    section ("TONE3000 / Pedal") re-file the patch to exactly that section,
    and lets the tag editor reach nested headings by typing what the drawer
    shows. */
export const CATEGORY_PATH_SEPARATOR = ' / ';

/** How a heading path is named in stored state — the drawer's open section and
    its per-section hand order, both of which live in `settings.json`.

    Joined with the same `/` a category is written with, and that is what makes
    it unambiguous: a segment cannot contain one, because `splitCategoryPath`
    is what splits on it. It replaced a NUL, which was unambiguous in the same
    way but is a control character in every store the key passes through — a
    JSON document, a settings file, a DOM attribute — and needed nothing to go
    wrong to be worth removing. */
export const SECTION_KEY_SEPARATOR = '/';

/** The key naming one patch heading. `patches:` distinguishes it from the
    plugins section, which is the one key that names no path. */
export function patchSectionKey(path: readonly string[]): string {
  return `patches:${path.join(SECTION_KEY_SEPARATOR)}`;
}

/** The key of the heading one level up, or undefined for a root — what
    closing a nested section hands the open state back to. */
export function parentSectionKey(path: readonly string[]): string | undefined {
  return path.length > 1 ? patchSectionKey(path.slice(0, -1)) : undefined;
}

/** Whether `openKey` names this section or something under it — the test for
    "draw this row open", since the stored key names the deepest open heading
    and every ancestor of it is open with it. The separator is what keeps this
    a prefix check rather than a path walk, and what stops "Amps" from
    claiming "Amps Extra". */
export function isSectionOnBranch(sectionKey: string, openKey: string): boolean {
  return openKey === sectionKey || openKey.startsWith(`${sectionKey}${SECTION_KEY_SEPARATOR}`);
}

/** A stored category string back into a heading path. Reading is deliberately
    looser than writing: any slash splits, with or without spaces around it —
    "Test/Sub" typed into the tag editor names the same path as the
    "Test / Sub" the drawer prints — and the " · " older patches were stored
    under still splits too. Empty segments are dropped so a stray separator
    cannot produce a heading with no name; an all-separator string counts as
    no category at all. */
export function splitCategoryPath(category: string): string[] {
  return category
    .split(/[/·]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** A patch paired with the heading path it files under, resolved once so the
    grouping and the tiles read the same answer. */
export interface DrawerPatch {
  patch: Patch;
  category: string[];
}

/** What a catalogue package put in the drawer: the pack patches it installed
    and the plugins it registered. Empty for a package the drawer has nothing
    to show for — an IR or capture pack, or anything not installed yet — which
    is what the Packages panel asks before offering to jump here at all.

    Patch ids are matched exactly as `packageForPatch` matches them, and only
    against pack patches: a patch the user saved is theirs, however its file
    happens to be named. */
export function packageDrawerItems(
  packageId: string,
  patches: readonly Patch[],
  plugins: readonly PluginInfo[],
): { patchIds: string[]; pluginIds: string[] } {
  return {
    patchIds: patches
      .filter((patch) => patch.readOnly && isPatchOfPackage(patch, packageId))
      .map((patch) => patch.id),
    pluginIds: plugins
      .filter((plugin) => plugin.packageId === packageId)
      .map((plugin) => plugin.id),
  };
}

/** The installed folder is named for the package id, so the join is exact —
    with a prefix fallback for a pack that ships several patches as
    `<packageId>_<name>` folders. */
function isPatchOfPackage(patch: Patch, packageId: string): boolean {
  return patch.id === packageId || patch.id.startsWith(`${packageId}_`);
}

/** The id of the package a pack patch came from, or undefined for a patch the
    user saved themselves. What the **Pack** badge points at: the badge says a
    patch arrived with a package, and this is the package it names. Only ever
    asked of a `readOnly` patch — a user's own patch id may coincide with a
    package's, and their patch is still theirs. */
export function packageIdForPatch(
  patch: Patch,
  packages: readonly CataloguePackage[],
): string | undefined {
  return patch.readOnly ? packageForPatch(patch, packages)?.id : undefined;
}

/** The package a pack patch came from. */
function packageForPatch(
  patch: Patch,
  packages: readonly CataloguePackage[],
): CataloguePackage | undefined {
  // Exact before prefix across the whole list: a package whose id is another's
  // prefix must not claim the longer one's patches just by sorting first.
  return (
    packages.find((pkg) => pkg.id === patch.id) ??
    packages.find((pkg) => isPatchOfPackage(patch, pkg.id))
  );
}

/** The heading path a patch files under. First answer wins:

    1. The category the user set on the patch itself.
    2. A TONE3000 patch's gear, under a TONE3000 heading — a downloaded tone
       arrives with no category and no package of its own, and filing twenty of
       them under "Uncategorised" would bury them. The two-level path costs no
       UI: the drawer already renders category paths as a tree.
    3. A pack patch's own package — the pack was authored under that heading.
    4. `DRAWER_UNCATEGORISED`.

    Deliberately *not* the package the patch's plugin came from: a patch the
    user saves is theirs, and it lands in the uncategorised row at the top of
    the drawer — in sight, ready to be filed by hand — rather than under
    whatever heading the catalogue happened to file its plugin.

    Never returns an empty path: a package with no category of its own falls
    through to the next answer rather than producing a heading with no name. */
export function patchCategory(patch: Patch, packages: readonly CataloguePackage[]): string[] {
  const own = patch.category?.trim();
  if (own) {
    const path = splitCategoryPath(own);
    if (path.length > 0) return path;
  }

  // After the user's own choice, so refiling a downloaded tone still wins.
  if (patch.tone3000) return tone3000Category(patch.tone3000);

  if (patch.readOnly) {
    const pack = packageForPatch(patch, packages);
    if (pack && pack.category.length > 0) return [...pack.category];
  }

  return [DRAWER_UNCATEGORISED];
}

/** The heading the catalogue files effect plugins under, pinned by name right
    behind TONE3000 — the rule is the user's ("effects third"), not derived. */
const EFFECTS_HEADING = 'Effects';

/** The drawer's patch tree: `groupByCategory` over patches with their resolved
    headings, then the root headings put in the drawer's fixed reading order —
    TONE3000 first, Effects second, the catalogue's other headings next, the
    headings the user made up after those, `DRAWER_UNCATEGORISED` last (the
    drawer hoists it out to the resolved row *above* every section, so last
    here is first on screen). The sort is stable, so catalogue order survives
    within the catalogue run and first-appearance order within the user's. */
export function groupPatches(
  patches: readonly Patch[],
  packages: readonly CataloguePackage[],
): CategoryNode<DrawerPatch>[] {
  const entries = patches.map((patch) => ({
    patch,
    category: patchCategory(patch, packages),
  }));
  // Case-folded like the grouping itself: a hand-typed "effects" heading is
  // the Effects section, pinned where Effects is pinned.
  const catalogueRoots = new Set(
    packages.map((pkg) => pkg.category[0]?.toLowerCase()).filter(Boolean),
  );
  const rank = (node: CategoryNode<DrawerPatch>) => {
    const root = node.category.toLowerCase();
    return root === TONE3000_HEADING.toLowerCase()
      ? 0
      : root === EFFECTS_HEADING.toLowerCase()
        ? 1
        : catalogueRoots.has(root)
          ? 2
          : root !== DRAWER_UNCATEGORISED.toLowerCase()
            ? 3
            : 4;
  };
  return [...groupByCategory(entries)].sort((a, b) => rank(a) - rank(b));
}

/** One heading's patches, the tree flattened depth-first with each node's own
    entries kept at its own level — the shape both the drawer's accordion and a
    module's patch menu list. `key` is stable for a heading path (the drawer
    persists the open section under it, and it keys the hand order); `label` is
    the path as the UI prints it. */
export interface PatchGroup {
  key: string;
  label: string;
  path: string[];
  entries: DrawerPatch[];
}

/** The patch tree as a flat list of headings, deepest last within a branch.
    Empty nodes are dropped — a parent that only exists to hold subsections is
    a heading with nothing under it. Shared so the drawer's sections and a
    module's patch menu can never disagree about what a heading contains. */
export function flattenPatchGroups(
  nodes: readonly CategoryNode<DrawerPatch>[],
  out: PatchGroup[] = [],
): PatchGroup[] {
  for (const node of nodes) {
    if (node.entries.length > 0)
      out.push({
        key: patchSectionKey(node.path),
        label: node.path.join(CATEGORY_PATH_SEPARATOR),
        path: [...node.path],
        entries: node.entries,
      });
    flattenPatchGroups(node.children, out);
  }
  return out;
}

/** The headings a list of patches falls under, each already in the user's hand
    order — `groupPatches` and `flattenPatchGroups` and `orderPatchEntries` in
    one call, which is the whole of what a patch menu needs. The drawer keeps
    its own composition because it interleaves plugin sections and has a
    reorder drag mid-flight to splice in. */
export function patchGroups(
  patches: readonly Patch[],
  packages: readonly CataloguePackage[],
  order: Readonly<Record<string, string[]>> = {},
): PatchGroup[] {
  return flattenPatchGroups(groupPatches(patches, packages)).map((group) => ({
    ...group,
    entries: orderPatchEntries(group.entries, order[group.key]),
  }));
}

/** A section's entries under the user's hand order: ids the order names come
    first, in that order; everything the order does not know keeps its incoming
    (name-sorted) order behind them, so a freshly saved patch appears without
    the stored order having to be touched. Ids naming patches no longer in the
    section are skipped. */
export function orderPatchEntries(
  entries: readonly DrawerPatch[],
  order: readonly string[] | undefined,
): DrawerPatch[] {
  if (!order || order.length === 0) return [...entries];
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = entries.filter((e) => rank.has(e.patch.id));
  const unknown = entries.filter((e) => !rank.has(e.patch.id));
  known.sort((a, b) => rank.get(a.patch.id)! - rank.get(b.patch.id)!);
  return [...known, ...unknown];
}

const pluginNameCollator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

/** The plugins bucketed under their manufacturer, vendors A→Z with the
    catch-all bucket pushed to the end. A vendor with a single plugin is no
    group worth a heading, so it joins the catch-all alongside the plugins
    that report no vendor at all. Entries are name-sorted within a bucket. */
export function groupPluginsByMaker(plugins: readonly PluginInfo[]): [string, PluginInfo[]][] {
  const sorted = [...plugins].sort((a, b) => pluginNameCollator.compare(a.name, b.name));

  const buckets = new Map<string, PluginInfo[]>();
  for (const plugin of sorted) {
    const maker = plugin.manufacturer?.trim() || UNKNOWN_MAKER;
    const bucket = buckets.get(maker);
    if (bucket) bucket.push(plugin);
    else buckets.set(maker, [plugin]);
  }

  const others = buckets.get(UNKNOWN_MAKER) ?? [];
  buckets.delete(UNKNOWN_MAKER);
  for (const [maker, makerPlugins] of buckets) {
    if (makerPlugins.length === 1) {
      others.push(makerPlugins[0]);
      buckets.delete(maker);
    }
  }

  const groups = [...buckets].sort(([a], [b]) => pluginNameCollator.compare(a, b));
  // Merged from several vendors, so the drawer needs sorting of its own.
  if (others.length) {
    groups.push([UNKNOWN_MAKER, others.sort((a, b) => pluginNameCollator.compare(a.name, b.name))]);
  }
  return groups;
}
