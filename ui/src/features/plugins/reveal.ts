/**
 * "Show me this in the Packages panel" — the mirror of the drawer's own reveal
 * channel (`features/drawer/reveal.ts`), and deliberately built to the same
 * shape.
 *
 * The panel already sends the other way: install something and it asks the
 * drawer to scroll to what arrived. This is the return trip, asked by a pack
 * patch's **Pack** badge — the badge says a patch came from a package, and the
 * obvious next question is "which one?", which nothing could answer before.
 *
 * Held until a panel subscribes, for exactly the reason the drawer's is: the
 * asker and the panel are not related by the component tree, and the panel is
 * only mounted while the Packages tool is the active one. A click therefore
 * switches the sidebar to it and *then* has something to talk to. The two
 * channels stay separate modules rather than one generic bus: each is one
 * signal into one component, and a shared bus would only invite a third
 * listener nobody reasoned about.
 */

/** How long an undelivered request survives — long enough for the sidebar to
    switch tools and the panel to mount, far short of a second visit. */
const PENDING_TTL_MS = 5000;

let pending: { packageId: string; at: number } | null = null;
let listener: ((packageId: string) => void) | null = null;

/** Ask the Packages panel to scroll to this package's row and flag it. Safe to
    call with the panel closed. Only ever one request in flight: a second click
    supersedes the first. */
export function revealPackageInPanel(packageId: string): void {
  if (listener) {
    listener(packageId);
    return;
  }
  pending = { packageId, at: performance.now() };
}

/** Subscribe the (single, at most) panel. Returns the unsubscribe. */
export function onPanelRevealRequest(handler: (packageId: string) => void): () => void {
  listener = handler;

  const held = pending;
  pending = null;
  if (held && performance.now() - held.at < PENDING_TTL_MS) {
    // Never synchronously during the panel's own mount: the handler clears the
    // filters and measures the list it is being registered from.
    queueMicrotask(() => handler(held.packageId));
  }

  return () => {
    if (listener === handler) listener = null;
  };
}
