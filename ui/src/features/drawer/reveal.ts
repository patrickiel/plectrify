/**
 * "Show me this in the drawer" — the one signal into the module drawer, asked
 * by the Packages panel about a package it has just installed and by a TONE3000
 * download about the patch it has just produced.
 *
 * The asker and the drawer are not related by the component tree (the panel
 * lives in the tools sidebar, a download starts in a window of its own, the
 * drawer sits at the foot of the rack) and, more to the point, the drawer is
 * only mounted in edit mode: a request turns edit mode on and *then* has
 * something to talk to. So it is held until a drawer subscribes, rather than
 * emitted into a listener that does not exist yet.
 *
 * Held briefly. A request nobody ever came for is stale — leaving it in place
 * would make the next entry into edit mode, minutes later, scroll and flash for
 * no reason the user could connect to anything.
 */

/** What was asked for. A package is resolved to whatever it put in the drawer
    (its plugins, or the patches a pack installed); a patch is already the
    thing itself — a downloaded tone is one patch and nothing else, and it has
    no package to be looked up through. `browse` names no content at all: it
    points at the drawer's own TONE3000 tile, which is where someone with an
    empty rack and nothing in mind is sent. */
export type RevealRequest =
  { kind: 'package'; id: string } | { kind: 'patch'; id: string } | { kind: 'browse' };

/** How long an undelivered request survives. Long enough for edit mode to turn
    on and the drawer to mount; far short of a second visit. */
const PENDING_TTL_MS = 5000;

let pending: { request: RevealRequest; at: number } | null = null;
let listener: ((request: RevealRequest) => void) | null = null;

/** Ask the module drawer to scroll to what this package installed and flag it.
    Safe to call with the drawer closed — see above. Only ever one request in
    flight: a second click supersedes the first. */
export function revealPackageInDrawer(packageId: string): void {
  send({ kind: 'package', id: packageId });
}

/** The same, for one patch — a tone that has just finished downloading. */
export function revealPatchInDrawer(patchId: string): void {
  send({ kind: 'patch', id: patchId });
}

/** Raise the drawer and flag its TONE3000 tile. Asked by the empty rack, whose
    one instruction is "drag something here" and whose answer to "from where?"
    is the drawer — with the tile as the offer for someone who has no patch of
    their own yet. */
export function revealBrowseInDrawer(): void {
  send({ kind: 'browse' });
}

function send(request: RevealRequest): void {
  if (listener) {
    listener(request);
    return;
  }
  pending = { request, at: performance.now() };
}

/** Subscribe the (single, at most) drawer. Returns the unsubscribe. */
export function onRevealRequest(handler: (request: RevealRequest) => void): () => void {
  listener = handler;

  const held = pending;
  pending = null;
  if (held && performance.now() - held.at < PENDING_TTL_MS) {
    // Never synchronously during the drawer's own mount: the handler measures
    // and scrolls the list it is being registered from.
    queueMicrotask(() => handler(held.request));
  }

  return () => {
    if (listener === handler) listener = null;
  };
}
