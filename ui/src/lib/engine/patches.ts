import type { Patch, RackModule } from './types';
import type { ModuleIcon, ModuleStyleVariant, ModuleTexture } from './moduleAppearance';
import { asModuleIcon, asModuleTexture, asStyleVariant } from './moduleAppearance';
import { normalizePositions } from './knobLayout';
import { isTone3000Provenance, type Tone3000Provenance } from './tone3000';

/**
 * Patches: a module's knob layout plus the plugin's own tone, one file each.
 *
 * `patches/<id>.patch` is the whole patch — its name, the plugin it was
 * built for, the knob mapping, and the plugin's serialised state. There is no
 * index file: the list is built by reading the directory. A patch is a small
 * number of files read once at startup, so an index would buy nothing and cost
 * the usual price of a second place for the same facts to live — a rename that
 * lands in one and not the other, sidecars orphaned by a delete that only got
 * half done.
 *
 * **The file name is the identity.** `id` is never stored inside the document;
 * it is the base name, which is what every path is built from and what keeps an
 * installed pack's patches from colliding with the user's own.
 */

/** Directory under the app-data dir holding the user's patches. Installed
    packs live in the shared root, which *is* its own patches directory — see
    `patchPath`. */
export const PATCH_DIR = 'patches';

const PATCH_EXT = '.patch';

/** Ids that may be turned into a file name. Ids come off disk — a file the
    user can rename, or a pack that was built elsewhere — so one must not be
    able to steer a read, a write or, worst, a delete. `resolveAppFile`
    sandboxes as well; this is the second, visible gate. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** One patch exactly as stored. The id is absent on purpose: it is the file
    name, so there is nothing to keep in step.

    `state` is the plugin's own serialised state, base64'd for JSON transport —
    opaque to TypeScript, which only ever moves it between the disk and the
    engine. It is optional: a capture can fail, and a pack may ship a mapping
    with no tone at all, which loads as just a layout. */
export interface StoredPatch {
  name: string;
  pluginName: string;
  /** The module card's look at capture time — its title override, accent
      colour, style variant, icon and texture. A patch is what gives a module
      its identity, and half of that identity is what the card says and how it
      looks, so they travel together. All are absent when the module was left
      at its defaults, and absent means "leave the card alone" on load: patches
      written before any of these fields carry none of them, and a pack may
      ship a mapping with no look of its own. */
  displayName?: string;
  color?: string;
  styleVariant?: ModuleStyleVariant;
  icon?: ModuleIcon;
  texture?: ModuleTexture;
  knobs: Patch['knobs'];
  /** The drawer heading the user filed this patch under. See `Patch.category`;
      absent means the heading is derived from the catalogue instead. */
  category?: string;
  /** The plugin's version at capture time. Advisory — a plugin owns its own
      state versioning — but worth logging when a restore looks wrong. */
  pluginVersion?: string;
  state?: string;
  /** Where this patch's capture came from, when it came from TONE3000.
      It is what lets the drawer show the tone's artwork and creator, what
      makes attribution possible, and what a repair uses to fetch the model
      again after a reinstall or on another machine. Derived from nothing, so
      every path that rebuilds a document has to carry it forward explicitly —
      `storedFromModule` knows nothing about it, exactly as with `category`. */
  tone3000?: Tone3000Provenance;
}

/** An installed patch is a folder, not a file: `<id>/patch.json` beside an
    `assets/` folder holding whatever the plugin loads — a capture, an impulse
    response, a sample. Plectrify never opens those; it only guarantees they land
    at the same absolute path on every machine, which is the only way a patch
    can be self-contained given that the path is baked into the plugin's own
    opaque state.

    A patch the user saves has no assets and stays a single file. Bundling one
    would mean copying it somewhere machine-independent and re-pointing the
    plugin at the copy, which is authoring work, not saving work — so it is the
    packaging tooling's job. */
const SHARED_PATCH_FILE = 'patch.json';

/** Where a patch's document lives, or null for an id that may not become a
    path. The shared package root is itself `%PROGRAMDATA%/Plectrify/patches`, so
    an installed pack's folders sit at its top level with no `patches/` prefix —
    that would resolve one folder too deep. */
export function patchPath(id: string, root?: 'shared'): string | null {
  if (!SAFE_ID.test(id)) return null;
  return root === 'shared' ? `${id}/${SHARED_PATCH_FILE}` : `${PATCH_DIR}/${id}${PATCH_EXT}`;
}

/** What a patch was called, and where it lived, before it was called a patch:
    one `presets/<id>.preset` per patch, and before that a `presets.json` index
    beside tone-only sidecars of the same name. These three names are frozen —
    they are not what Plectrify writes any more, they are what is already on
    users' disks, so renaming them here would simply lose the files. Read once
    at startup and migrated into `patches/`; see
    `JuceEngine.migrateLegacyPatches`. */
const LEGACY_DIR = 'presets';
const LEGACY_EXT = '.preset';
export const LEGACY_INDEX_FILE = 'presets.json';

/** Where a patch was stored under the old name, or null for an id that may not
    become a path — the same gate `patchPath` applies, since these ids reach the
    new files. */
export function legacyPatchPath(id: string): string | null {
  if (!SAFE_ID.test(id)) return null;
  return `${LEGACY_DIR}/${id}${LEGACY_EXT}`;
}

/** The whole legacy directory, for the one listing the migration makes. */
export const LEGACY_PATCH_DIR = LEGACY_DIR;

function idsWithExtension(names: string[], extension: string): string[] {
  return names
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length))
    .filter((id) => SAFE_ID.test(id));
}

/** The patch ids among the user's patch files. Anything that is not a patch
    is left alone: the folder is the user's. */
export function patchIdsFrom(names: string[]): string[] {
  return idsWithExtension(names, PATCH_EXT);
}

/** The same, for the pre-rename directory. */
export function legacyPatchIdsFrom(names: string[]): string[] {
  return idsWithExtension(names, LEGACY_EXT);
}

/** The patch ids among the shared root's folder names. One folder is one
    installed patch; the name is its id, exactly as a file name is for the
    user's own. */
export function sharedPatchIdsFrom(dirs: string[]): string[] {
  return dirs.filter((name) => SAFE_ID.test(name));
}

/** Capture a module's current knob layout, ready to be written as a patch. An
    empty name falls back to the plugin name (patches match by plugin). The
    tone is added by the caller, which is the only side that can ask the engine
    for it. */
export function storedFromModule(module: RackModule, name: string): StoredPatch {
  return {
    name: name.trim() || module.name,
    pluginName: module.name,
    displayName: module.displayName,
    color: module.color,
    styleVariant: module.styleVariant,
    icon: module.icon,
    texture: module.texture,
    knobs: normalizePositions(module.params).map((p) => ({
      paramIndex: p.paramIndex,
      label: p.label,
      isMeter: p.isMeter,
      meterBipolar: p.meterBipolar,
      pos: p.pos,
    })),
  };
}

export function isStoredPatch(value: unknown): value is StoredPatch {
  const doc = value as Partial<StoredPatch> | null;
  return (
    typeof doc?.name === 'string' &&
    typeof doc?.pluginName === 'string' &&
    (doc.displayName === undefined || typeof doc.displayName === 'string') &&
    (doc.color === undefined || typeof doc.color === 'string') &&
    // String-typed only, not union-validated: an id this build doesn't know
    // must not reject the whole patch file — `toPatch` degrades it instead.
    (doc.styleVariant === undefined || typeof doc.styleVariant === 'string') &&
    (doc.icon === undefined || typeof doc.icon === 'string') &&
    (doc.texture === undefined || typeof doc.texture === 'string') &&
    Array.isArray(doc?.knobs) &&
    doc.knobs.every((k) => typeof k?.paramIndex === 'number' && typeof k?.label === 'string') &&
    (doc.category === undefined || typeof doc.category === 'string') &&
    (doc.pluginVersion === undefined || typeof doc.pluginVersion === 'string') &&
    (doc.state === undefined || (typeof doc.state === 'string' && doc.state.length > 0)) &&
    // Same leniency as the union fields above, and it matters more here: a
    // malformed provenance costs the patch its TONE3000 identity, and that is a
    // far better outcome than refusing to load the patch at all.
    (doc.tone3000 === undefined || isTone3000Provenance(doc.tone3000))
  );
}

/** The list entry for a stored patch. The tone stays on disk: the UI never
    sees it, exactly as it never sees a `Rig`'s, and a rack's worth of captures
    has no business sitting in memory all session. The card's look does come
    along, since loading a patch applies it in the same pass as the mapping —
    it is a couple of short strings, not a blob. */
export function toPatch(id: string, doc: StoredPatch, readOnly = false): Patch {
  const patch: Patch = {
    id,
    name: doc.name,
    pluginName: doc.pluginName,
    displayName: doc.displayName,
    color: doc.color,
    styleVariant: asStyleVariant(doc.styleVariant),
    icon: asModuleIcon(doc.icon),
    texture: asModuleTexture(doc.texture),
    knobs: doc.knobs,
    category: doc.category,
    tone3000: isTone3000Provenance(doc.tone3000) ? doc.tone3000 : undefined,
  };
  return readOnly ? { ...patch, readOnly: true } : patch;
}

/** The card title a patch asks for when it lands on a module, or `undefined`
    when it asks for nothing and the module's own name should stand.

    A TONE3000 patch is the exception, and the reason this is a function rather
    than a field read: its name *is* the tone, and a card sealed to a capture
    must say which capture it is playing. Its stored `displayName` is whatever
    the module was called when the tone was downloaded onto it — the tone
    before this one, as often as not — so trusting it leaves every card in the
    rack wearing the name of the first tone ever loaded there. */
export function patchTitleOverride(
  patch: Pick<Patch, 'name' | 'displayName' | 'tone3000'>,
): string | undefined {
  return patch.tone3000 ? patch.name : patch.displayName;
}

/** Display order. A directory listing's order is the file system's business,
    so the list is sorted rather than inherited; the id breaks ties, since two
    patches may share a name. */
export function byName(a: Patch, b: Patch): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** What the UI sees: the user's own patches first, then anything installed.
    The two lists are kept apart everywhere else — a shipped patch must never
    be written into the user's directory, or it would outlive uninstalling its
    pack. */
export function mergePatches(user: Patch[], shipped: Patch[]): Patch[] {
  return [...user, ...shipped];
}
