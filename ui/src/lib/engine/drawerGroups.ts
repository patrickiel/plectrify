import { tone3000Category } from './tone3000';
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

/** A patch paired with the heading path it files under, resolved once so the
    grouping and the tiles read the same answer. */
export interface DrawerPatch {
  patch: Patch;
  category: string[];
}

/** pluginName → packageId for every plugin the catalogue installed, from the
    natively joined plugins list. Keyed by display name because that is the
    only plugin identity a patch carries (`Patch.pluginName`). */
export function pluginPackageIds(plugins: readonly PluginInfo[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const plugin of plugins) {
    if (plugin.packageId) ids.set(plugin.name, plugin.packageId);
  }
  return ids;
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
    4. The package the patch's plugin was installed from — a patch saved for a
       catalogue plugin belongs where that plugin is filed.
    5. `DRAWER_UNCATEGORISED`.

    Never returns an empty path: a package with no category of its own falls
    through to the next answer rather than producing a heading with no name. */
export function patchCategory(
  patch: Patch,
  packages: readonly CataloguePackage[],
  pluginPackageIdByName: ReadonlyMap<string, string>,
): string[] {
  const own = patch.category?.trim();
  if (own) return [own];

  // After the user's own choice, so refiling a downloaded tone still wins.
  if (patch.tone3000) return tone3000Category(patch.tone3000);

  if (patch.readOnly) {
    const pack = packageForPatch(patch, packages);
    if (pack && pack.category.length > 0) return [...pack.category];
  }

  const pluginPackageId = pluginPackageIdByName.get(patch.pluginName);
  if (pluginPackageId !== undefined) {
    const pack = packages.find((pkg) => pkg.id === pluginPackageId);
    if (pack && pack.category.length > 0) return [...pack.category];
  }

  return [DRAWER_UNCATEGORISED];
}

/** The drawer's patch tree: `groupByCategory` over patches with their resolved
    headings, catalogue heading order preserved, `DRAWER_UNCATEGORISED` moved
    last — `groupByCategory` only knows to demote its own fallback label, and
    every path here is non-empty, so it never sees these as uncategorised. */
export function groupPatches(
  patches: readonly Patch[],
  packages: readonly CataloguePackage[],
  plugins: readonly PluginInfo[],
): CategoryNode<DrawerPatch>[] {
  const pluginPackages = pluginPackageIds(plugins);
  const entries = patches.map((patch) => ({
    patch,
    category: patchCategory(patch, packages, pluginPackages),
  }));
  const roots = groupByCategory(entries);
  const uncategorised = roots.filter((node) => node.category === DRAWER_UNCATEGORISED);
  return [...roots.filter((node) => node.category !== DRAWER_UNCATEGORISED), ...uncategorised];
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
