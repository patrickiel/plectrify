import type { HiddenPlugin, PluginInfo } from './types';
import { pluginIdentityKey } from './patches';

/**
 * Which plugins the module drawer leaves out, because the user said so — a
 * drum machine has no place in a guitar chain, and removing it from the disk
 * is not this app's to ask.
 *
 * Hiding is the drawer's business and nothing else's. A hidden plugin is still
 * scanned, because the scan's result is what a rig finds its plugins in: skip
 * one there and every rig using it stops loading. And it still answers to a
 * patch tile, since a patch is something the user kept on purpose.
 *
 * Entries are the plugin's identity (name + format, see `pluginIdentityKey`)
 * and not `PluginInfo.id`, whose value hashes the file's path: a plugin moved
 * or updated into another folder is the same plugin, and must stay hidden. It
 * also means an entry says what to print on its own, so one whose plugin has
 * since been uninstalled can still be listed and removed — otherwise it would
 * sit there invisibly and hide the plugin again on the day it came back.
 */

/** The drag type a drawer plugin chip carries, and the only one the Hidden
    plugins card accepts or lights up for: a patch tile's drag looks the same to
    the rack, and hiding a patch's plugin is not what dragging a patch means. */
export const HIDE_PLUGIN_DRAG_TYPE = 'application/x-plectrify-hide-plugin';

/** What a chip puts under that type: the identity, which is all a list entry
    is. Readable only at the drop, as with every other drag payload. */
export function hidePluginDragData(plugin: Pick<PluginInfo, 'name' | 'format'>): string {
  return JSON.stringify({ name: plugin.name, format: plugin.format });
}

/** The entry a dropped payload names, or null for anything malformed. */
export function parseHidePluginDrag(data: string): HiddenPlugin | null {
  try {
    return normalizeHiddenPlugins([JSON.parse(data)])[0] ?? null;
  } catch {
    return null;
  }
}

/** Keep only well-formed entries of a stored list, one per identity, in the
    order the Settings card lists them. A format that is not the older one reads
    as VST3, as everywhere else a document omits it. */
export function normalizeHiddenPlugins(value: unknown): HiddenPlugin[] {
  if (!Array.isArray(value)) return [];
  const byIdentity = new Map<string, HiddenPlugin>();
  for (const entry of value as Partial<HiddenPlugin>[]) {
    if (typeof entry?.name !== 'string' || entry.name === '') continue;
    const format = entry.format === 'legacy' ? 'legacy' : 'vst3';
    byIdentity.set(pluginIdentityKey(entry.name, format), { name: entry.name, format });
  }
  return [...byIdentity.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format),
  );
}

/** The list with this plugin added. */
export function hidePlugin(
  hidden: readonly HiddenPlugin[],
  plugin: Pick<PluginInfo, 'name' | 'format'>,
): HiddenPlugin[] {
  return normalizeHiddenPlugins([...hidden, plugin]);
}

/** The list with this entry gone: the plugin is back in the drawer. */
export function showPlugin(
  hidden: readonly HiddenPlugin[],
  plugin: Pick<HiddenPlugin, 'name' | 'format'>,
): HiddenPlugin[] {
  const key = pluginIdentityKey(plugin.name, plugin.format);
  return hidden.filter((entry) => pluginIdentityKey(entry.name, entry.format) !== key);
}

/** The plugins the drawer shows. Every other reader of the plugin list keeps
    the whole of it, which is what keeps a hidden plugin's patches and rigs
    working. */
export function visiblePlugins(
  plugins: readonly PluginInfo[],
  hidden: readonly HiddenPlugin[],
): PluginInfo[] {
  const keys = new Set(hidden.map((entry) => pluginIdentityKey(entry.name, entry.format)));
  return plugins.filter((plugin) => !keys.has(pluginIdentityKey(plugin.name, plugin.format)));
}
