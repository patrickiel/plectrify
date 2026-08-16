let fallbackCounter = 0;

/** Creates an opaque UI-owned identity that remains unique across WebView
    reloads. IDs are persisted in patches/rigs and shared with the native rack,
    so a page-local incrementing counter is not sufficient. */
export function uid(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${prefix}-${randomUuid}`;

  // Older embedded browsers may not expose randomUUID. Time + random entropy
  // keeps this fallback independent from previous page lifetimes; the counter
  // only disambiguates multiple calls in the same tick.
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackCounter}`;
}
