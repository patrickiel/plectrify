/** The module card's optional appearance vocabulary — style variants, icons
    and textures — and the guards that admit values off disk.

    These ids are persisted in patches, rigs and the working session, all of
    which are plain JSON a user can hand-edit, so reads go through the `as*`
    guards below: an unknown id degrades to `undefined` — the default look —
    rather than rejecting the whole document. The id lists can therefore grow
    freely; renaming or removing an id only costs the saved looks using it. */

/** How strongly the accent colour is worn. `subtle` is the default and is
    never persisted — an absent field means subtle, which is also what every
    file written before this field existed says. */
export const MODULE_STYLE_VARIANTS = ['subtle', 'bold', 'outline'] as const;
export type ModuleStyleVariant = (typeof MODULE_STYLE_VARIANTS)[number];

/** CSS-only material laid under the tint. */
export const MODULE_TEXTURES = ['metal', 'tolex', 'carbon'] as const;
export type ModuleTexture = (typeof MODULE_TEXTURES)[number];

/** Glyph shown beside the module title; see `MODULE_GLYPHS` for the artwork. */
export const MODULE_ICONS = [
  'amp',
  'cab',
  'drive',
  'fuzz',
  'delay',
  'reverb',
  'mod',
  'comp',
  'eq',
  'pitch',
  'filter',
  'util',
] as const;
export type ModuleIcon = (typeof MODULE_ICONS)[number];

function oneOf<T extends string>(ids: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (ids as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function asStyleVariant(v: unknown): ModuleStyleVariant | undefined {
  return oneOf(MODULE_STYLE_VARIANTS, v);
}

export function asModuleTexture(v: unknown): ModuleTexture | undefined {
  return oneOf(MODULE_TEXTURES, v);
}

export function asModuleIcon(v: unknown): ModuleIcon | undefined {
  return oneOf(MODULE_ICONS, v);
}

/** A full six-digit hex colour, or undefined. Stricter than the other guards
    because the value is interpolated into an inline `style` attribute — this
    is an injection gate, not just a schema check. */
export function asModuleColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
}
