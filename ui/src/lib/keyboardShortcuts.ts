/** Match a browser key value against a shortcut sequence. Letters are case-insensitive. */
export function shortcutIndex(key: string, shortcuts: readonly string[]): number {
  const normalized = key.length === 1 ? key.toUpperCase() : key;
  return shortcuts.indexOf(normalized);
}
