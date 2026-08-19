import type { HTMLAttributes } from 'svelte/elements';
import { orderPatchEntries, type DrawerPatch } from '../../lib/engine/drawerGroups';
import type { DrawerSection, PatchNode } from './drawerTree';
import type { Patch } from '../../lib/engine/types';

/**
 * The drawer's own drag: reordering a patch inside its section, carrying it
 * under another heading, and the mid-flight conversion between "this is going
 * to the rack" and "this is staying in here".
 *
 * A tile dragged out of the drawer is the rack's drag, and stays the rack's
 * until it is carried back over the drawer — at which point it becomes a
 * reorder, the list rearranges live under the pointer, and the drop commits
 * the order to the persisted setting. Carrying it out again hands it back to
 * the rack. The two directions are one gesture, and nothing has to be clicked
 * to undo either.
 *
 * **A section adopts a drag carried over its tiles**, whichever section that
 * is. The preview moves there, its tiles step aside under the pointer, and the
 * drop re-files the patch *and* commits the place it is being shown in. Filing
 * and placing used to be two gestures — drop to change the heading, then pick
 * the tile up again to say where in it — and the second one is the whole of
 * what this removes; a heading is still a target in its own right, for the
 * section that is closed or empty, and dropping on one files the patch at the
 * end of it. Carrying the drag back over the section it came from is the same
 * rule read backwards: that section adopts it again and its own order returns.
 *
 * Markup contract: spread `{...drag.rootAttrs}` on the drawer root (the
 * `dragBack` watch, which must run before the window listener sees the same
 * event bubble). A patch section's container gets `reorderOver`/`reorderDrop`
 * plus `refileLeave`; a section header gets the `refile*` trio.
 *
 * The gesture reads its surroundings through the getter bag handed to the
 * constructor — never plain values, which JS would freeze at construction.
 */

/** The in-flight reorder: which patch, the section it is filed under, the
    section the preview has been carried into, and that section's ids in the
    order shown right now (the live preview the drop commits). */
export interface Reorder {
  /** Where the patch is filed — the section the drag started in. A drop
      anywhere else is a re-file as well as a placement. */
  homeKey: string;
  /** The section hosting the preview: `homeKey` until the drag is carried
      over another section's tiles, which adopt it. */
  sectionKey: string;
  patchId: string;
  ids: string[];
}

/** Where the dragged id lands: before or after the tile the pointer is over.
    Null when nothing would change — the guard that stops a dragover stream
    rewriting the same order at pointer rate. */
export function previewOrder(
  ids: readonly string[],
  draggedId: string,
  overId: string,
  after: boolean,
): string[] | null {
  if (overId === draggedId) return null;
  if (ids.indexOf(overId) < 0) return null;
  const next = ids.filter((id) => id !== draggedId);
  next.splice(next.indexOf(overId) + (after ? 1 : 0), 0, draggedId);
  return next.some((id, i) => id !== ids[i]) ? next : null;
}

/** The order a section takes the moment it adopts a drag: its own, with the
    incoming id appended if it is not already in it. Appended, so a tile
    arriving over the section's empty space already has a place before the
    pointer has crossed a tile — and a tile carried back to where it came from
    keeps the one it started in, since that order already names it. */
export function adoptOrder(ids: readonly string[], patchId: string): string[] {
  return ids.includes(patchId) ? [...ids] : [...ids, patchId];
}

/** Whether this section can take the dragged patch: another patch section than
    the one hosting the preview, and a patch of the user's own — a pack's
    read-only patch is filed by its pack and cannot be re-filed, exactly as its
    tile offers no tag button. */
export function canRefileInto(
  reorder: Reorder | null,
  section: DrawerSection,
  patches: readonly Patch[],
): boolean {
  if (!reorder || section.kind !== 'patches' || section.key === reorder.sectionKey) return false;
  const dragged = patches.find((p) => p.id === reorder.patchId);
  return dragged !== undefined && !dragged.readOnly;
}

/** A section's entries in the live preview's order. Ids naming entries that
    have gone are skipped, and entries the order does not name are dropped —
    the preview is a snapshot of the section it was taken from. `incoming` is
    the tile carried in from elsewhere, which the section's own entries do not
    know about yet. */
export function applyPreview(
  base: readonly DrawerPatch[],
  ids: readonly string[],
  incoming?: DrawerPatch,
): DrawerPatch[] {
  const byId = new Map(base.map((entry) => [entry.patch.id, entry]));
  if (incoming) byId.set(incoming.patch.id, incoming);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Spring-loaded headings: a refile drag held still over a closed one opens
    it after a beat, so a patch can be carried down into a subsection — which
    is otherwise unreachable, since putting the drag down to open the parent is
    what ends it. The delay is the whole design: a drag merely crossing a
    heading on its way somewhere else must not open it. */
const HOVER_OPEN_MS = 600;

interface DragDeps {
  patches: () => readonly Patch[];
  patchOrder: () => Record<string, string[]>;
  sections: () => readonly DrawerSection[];
  /** The drawer is held down out of the way by a drag that left it. */
  lowered: () => boolean;
  isOpen: (section: DrawerSection) => boolean;
  onSetOpenSection: (key: string) => void;
  onSetPatchCategory: (patchId: string, category: string) => void;
  onReorderPatches: (sectionKey: string, patchIds: string[]) => void;
  /** The rack's own end-of-drag, reported from here rather than from the
      tile — see #done. */
  onRackDragEnd: () => void;
}

export class DrawerDrag {
  reorder = $state<Reorder | null>(null);

  /** The drag that lowered the drawer has come back over it.
   *
   * Lowering is only ever "you are aiming at the rack, so here is the rack" —
   * and the moment the tile is carried back over the shelf that is no longer
   * true: the user is returning to the list, to put the tile back or to think
   * again about which one they meant. So the shelf is a hover target for the
   * whole of that drag, and the drawer rises to meet it. Leaving it lowers it
   * again. Visual and local, like `lowered` itself: nothing is persisted and
   * it dies with the drag.
   *
   * It is also what makes the drag a reorder again while it is in here — see
   * #convert. Raising the list without that is a list that looks live and
   * rearranges nothing. */
  dragBack = $state(false);

  /** A plain rack drag in flight from one of our patch tiles — the drag that
      may still turn out to be a reorder by returning to the drawer. Armed
      only, never committed: while it is outside, it stays the rack's drag
      untouched. */
  #armed: { sectionKey: string; patchId: string } | null = null;

  /** A rack drag left one of our tiles, convertible or not — what says the
      rack has to be told when the gesture ends (see #done). */
  #rackDrag = false;

  /** The heading the pointer is over right now, if a drop there would file
      the patch under it. */
  #headerKey = $state<string | null>(null);

  /** Deliberately not `$state`: written on every dragover, and nothing
      renders it. */
  #hoverKey: string | null = null;
  #hoverTimer: ReturnType<typeof setTimeout> | undefined;
  #deps: DragDeps;

  constructor(deps: DragDeps) {
    this.#deps = deps;
  }

  /** The section a drop right now would file the patch under, drawn
      highlighted so the destination answers before the drop commits: the
      heading under the pointer, or — once another section has adopted the
      drag — that section, whose tiles have already stepped aside for it. */
  get refileKey(): string | null {
    const reorder = this.reorder;
    if (!reorder) return null;
    if (this.#headerKey !== null) return this.#headerKey;
    return reorder.sectionKey !== reorder.homeKey ? reorder.sectionKey : null;
  }

  get rootAttrs(): HTMLAttributes<HTMLDivElement> {
    return {
      ondragover: this.#backOver,
      ondragleave: this.#backLeave,
      // #done clears this too, but only for a drag one of our patch tiles
      // started: a plugin chip or the TONE3000 tile lowers the drawer just the
      // same and has no gesture of ours to end.
      ondrop: this.#clearBack,
      ondragend: this.#clearBack,
    };
  }

  /** A section's entries as displayed: the persisted hand order over the
      name-sorted list, overridden by the live preview while a reorder drag is
      being shown in this section — and with the tile subtracted from the
      section it is being carried out of, so it is never drawn twice. */
  orderedEntries(section: PatchNode): DrawerPatch[] {
    const base = orderPatchEntries(section.entries, this.#deps.patchOrder()[section.key]);
    const reorder = this.reorder;
    if (!reorder) return base;
    if (reorder.sectionKey === section.key)
      return applyPreview(base, reorder.ids, this.#draggedEntry());
    if (reorder.homeKey === section.key)
      return base.filter((entry) => entry.patch.id !== reorder.patchId);
    return base;
  }

  /** A plain drag left a tile for the rack. `convertible` arms the mid-drag
      conversion with it — coming back over the drawer (see #convert) — and is
      false while the list is filtered, where the order on screen is not the
      order that is stored and a reorder would mean nothing. The rest of the
      bookkeeping is the same either way: the rack is holding state for this
      drag and has to be told when it ends. */
  armPlainDrag(sectionKey: string, patchId: string, convertible: boolean): void {
    this.#rackDrag = true;
    if (convertible) {
      this.#armed = { sectionKey, patchId };
      window.addEventListener('dragover', this.#convert);
    }
    this.#watch();
  }

  startReorder(sectionKey: string, patchId: string): void {
    const section = this.#patchSection(sectionKey);
    if (!section) return;
    this.reorder = { homeKey: sectionKey, sectionKey, patchId, ids: this.#sectionIds(section) };
    this.#watch();
  }

  /** dragend from a plain (rack) drag. Named apart from `endReorder` because a
      tile reports one or the other and never both, and they read differently
      at the call site — but both land on the same teardown, which is the whole
      point of there being one. */
  endPlainDrag(): void {
    this.#done();
  }

  /** dragend from a reorder: after a landed drop's commit (which has already
      torn the gesture down, so this finds nothing left), and on its own for a
      drag released elsewhere, which snaps the preview back by discarding it. */
  endReorder(): void {
    this.#done();
  }

  refileOver(e: DragEvent, section: DrawerSection): void {
    if (this.#canRefile(section)) {
      this.#accept(e);
      this.#headerKey = section.key;
      this.#armHoverOpen(section);
      return;
    }
    // The heading of the section that has already adopted the drag: a drop
    // there lands the placement its tiles are showing, rather than being a
    // strip of nothing across the top of the target.
    if (this.#adoptedBy(section)) this.#accept(e);
  }

  refileLeave(section: DrawerSection): void {
    if (this.#headerKey === section.key) this.#headerKey = null;
    if (this.#hoverKey === section.key) this.#cancelHoverOpen();
  }

  refileDrop(e: DragEvent, section: DrawerSection): void {
    if (section.kind !== 'patches') return;
    if (this.#adoptedBy(section)) return this.#land(e, section);
    if (!this.#canRefile(section)) return;
    e.preventDefault();
    // Home's own heading is where the patch already is: the drag is simply
    // put down, and nothing is written.
    const reorder = this.reorder!;
    if (section.key !== reorder.homeKey)
      this.#deps.onSetPatchCategory(reorder.patchId, section.label);
    this.#done();
  }

  /** Live preview: the section under the pointer adopts the drag if it has not
      already, and as the drag crosses a tile the dragged id moves before or
      after it depending on which half of the tile the pointer is in. */
  reorderOver(e: DragEvent, section: PatchNode): void {
    const reorder = this.reorder;
    if (!reorder) return;
    if (reorder.sectionKey !== section.key) {
      if (!this.#canRefile(section)) return;
      reorder.sectionKey = section.key;
      reorder.ids = adoptOrder(this.#sectionIds(section), reorder.patchId);
      this.#cancelHoverOpen();
    }
    this.#accept(e);
    const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-reveal-id]');
    const overId = tile?.dataset.revealId;
    if (!tile || overId === undefined) return;
    const rect = tile.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const next = previewOrder(reorder.ids, reorder.patchId, overId, after);
    if (next) reorder.ids = next;
  }

  reorderDrop(e: DragEvent, section: PatchNode): void {
    if (this.reorder?.sectionKey !== section.key) return;
    this.#land(e, section);
  }

  /** The drawer is going away with a drag still in flight (edit mode left);
      the window must not keep this gesture's listeners, nor a timer fire into
      a component that is gone. */
  destroy(): void {
    this.#unwatch();
    window.removeEventListener('dragover', this.#convert);
    this.#cancelHoverOpen();
  }

  /** The drop that ends the gesture where the preview shows it: the patch
      takes this section — re-filed if it is not the one it came from — and
      this section's hand order becomes the preview's. */
  #land(e: DragEvent, section: PatchNode): void {
    const reorder = this.reorder;
    if (!reorder) return;
    e.preventDefault();
    if (section.key !== reorder.homeKey)
      this.#deps.onSetPatchCategory(reorder.patchId, section.label);
    this.#deps.onReorderPatches(section.key, [...reorder.ids]);
    this.#done();
  }

  #accept(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  #canRefile(section: DrawerSection): boolean {
    return canRefileInto(this.reorder, section, this.#deps.patches());
  }

  /** This section is hosting the preview, having taken it from another — the
      state a drop lands rather than merely re-files. Never the section the
      patch is already filed under: that one is an ordinary reorder. */
  #adoptedBy(section: DrawerSection): boolean {
    const reorder = this.reorder;
    return (
      reorder !== null && section.key === reorder.sectionKey && section.key !== reorder.homeKey
    );
  }

  #patchSection(key: string): PatchNode | undefined {
    return this.#deps.sections().find((s): s is PatchNode => s.kind === 'patches' && s.key === key);
  }

  #sectionIds(section: PatchNode): string[] {
    return orderPatchEntries(section.entries, this.#deps.patchOrder()[section.key]).map(
      (entry) => entry.patch.id,
    );
  }

  /** The entry the drag is carrying, looked up where the patch is still filed
      — the section showing the preview has no entry for it yet. */
  #draggedEntry(): DrawerPatch | undefined {
    const reorder = this.reorder;
    if (!reorder || reorder.sectionKey === reorder.homeKey) return undefined;
    return this.#patchSection(reorder.homeKey)?.entries.find(
      (entry) => entry.patch.id === reorder.patchId,
    );
  }

  /** The mid-drag conversion, and the one rule that decides which drag this
   * is: an armed rack drag is a reorder while it is back over the drawer, and
   * the rack's drag again the moment it leaves — the preview snaps back and
   * the drawer lowers out of the way.
   *
   * A tile carried back into the list it came from is not on its way to the
   * rack any more; it is being put somewhere in here. Nothing has to be held
   * down to say so, and nothing has to be released to take it back.
   *
   * Watched on the window, not the drawer: dragover bubbles up from wherever
   * the cursor is, so both directions answer continuously rather than waiting
   * for the drag to find the drawer's lowered shelf. `dragBack` is set by the
   * drawer root's own handler, which runs earlier in the same event's bubble,
   * so it is never a frame stale here. Dropping on the rack still inserts
   * regardless. */
  #convert = (): void => {
    if (!this.#armed) return;
    if (this.dragBack && !this.reorder)
      this.startReorder(this.#armed.sectionKey, this.#armed.patchId);
    else if (!this.dragBack && this.reorder) this.reorder = null;
  };

  #backOver = (): void => {
    if (this.#deps.lowered()) this.dragBack = true;
  };

  /** dragleave also fires crossing between children, which would flicker the
      drawer shut on every internal boundary — so a leave counts only when the
      drag has genuinely gone somewhere outside the drawer. */
  #backLeave = (e: DragEvent): void => {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget as HTMLElement).contains(to)) return;
    this.dragBack = false;
  };

  #clearBack = (): void => {
    this.dragBack = false;
  };

  /** The end of the gesture, watched on the window rather than taken from the
   * tile's own dragend.
   *
   * The tile is not there to report it. A section that adopts the drag draws
   * the tile itself, and the heading it sprang open closed the one the drag
   * started in — either way the source element has been replaced, and Chromium
   * does not deliver `dragend` to a node that has left the document. So the
   * drop and the dragend are watched wherever they land, and a mouse move is
   * the backstop for the drag that fires neither: Escape ends one with nothing
   * dispatched at all, and a move is the first thing heard afterwards, since
   * ordinary mouse events are suppressed for as long as a drag is running.
   *
   * Deliberately not `mouseup`, which would be the obvious other half: it is
   * the very event a drop is made of, and a browser dispatching it before the
   * `drop` would tear the preview down a moment before the drop went to commit
   * it. A move costs a pixel and cannot land in the middle of anything. */
  #watch(): void {
    window.addEventListener('drop', this.#done);
    window.addEventListener('dragend', this.#done);
    window.addEventListener('mousemove', this.#idle);
  }

  #unwatch(): void {
    window.removeEventListener('drop', this.#done);
    window.removeEventListener('dragend', this.#done);
    window.removeEventListener('mousemove', this.#idle);
  }

  /** Escape ends the drag with the button still down, so the move that says so
      is the one after it comes back up. */
  #idle = (e: MouseEvent): void => {
    if (e.buttons === 0) this.#done();
  };

  /** Everything one gesture leaves behind, dropped at once and idempotently —
      it runs from the drop that landed the preview, from the tile's dragend
      when there still is one, and from the window watch when there is not. */
  #done = (): void => {
    const wasRackDrag = this.#rackDrag;
    this.#unwatch();
    window.removeEventListener('dragover', this.#convert);
    this.#armed = null;
    this.#rackDrag = false;
    this.dragBack = false;
    this.reorder = null;
    this.#headerKey = null;
    this.#cancelHoverOpen();
    // The rack lowered the drawer for this drag and holds insert state for it,
    // and the tile that would have told it so may be gone.
    if (wasRackDrag) this.#deps.onRackDragEnd();
  };

  #armHoverOpen(section: DrawerSection): void {
    // Already counting for this one: the dragover stream must not restart the
    // clock on every event, or a held drag would never reach the delay.
    if (this.#hoverKey === section.key) return;
    this.#cancelHoverOpen();
    if (this.#deps.isOpen(section)) return;
    this.#hoverKey = section.key;
    this.#hoverTimer = setTimeout(() => {
      this.#hoverTimer = undefined;
      this.#hoverKey = null;
      this.#deps.onSetOpenSection(section.key);
    }, HOVER_OPEN_MS);
  }

  #cancelHoverOpen(): void {
    clearTimeout(this.#hoverTimer);
    this.#hoverTimer = undefined;
    this.#hoverKey = null;
  }
}
