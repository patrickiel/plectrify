/** The two plugin formats the engine hosts, and the one rule about naming the
    second: it is never called "VST2" or "VST" anywhere a user reads. "VST" is
    Steinberg's registered trademark and this format is hosted through a
    clean-room header (FST — see THIRD_PARTY_NOTICES.md), so the page says
    "plugins" when it means plugins in general and names the *file extension*
    when it has to be specific. Only VST3 is ever called by its name. */

/** `'vst3'` is a `.vst3` bundle; `'legacy'` is the older single-file format
    (`.dll` on Windows, `.vst` bundle on macOS, `.so` on Linux). Documents
    written before the field existed carry none, and every one of those was
    VST3 — the only format there was — so absent reads as `'vst3'`. */
export type PluginFormat = 'vst3' | 'legacy';

export type PluginPlatform = 'windows' | 'macos' | 'linux';

/** What a legacy plugin is on this platform, as the user sees it in their
    file manager: the honest, trademark-free name for the format. */
export function legacyPluginExtension(platform: PluginPlatform | undefined): string {
  switch (platform) {
    case 'macos':
      return '.vst';
    case 'linux':
      return '.so';
    default:
      return '.dll';
  }
}

/** Reads a document's format field, defaulting the pre-field documents. */
export function pluginFormatOf(format: PluginFormat | undefined): PluginFormat {
  return format ?? 'vst3';
}
