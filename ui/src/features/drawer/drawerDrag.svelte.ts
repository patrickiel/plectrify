import type { HTMLAttributes } from 'svelte/elements';
import { orderPatchEntries, type DrawerPatch } from '../../lib/engine/drawerGroups';
import type { DrawerSection, PatchNode } from './drawerTree';
import type { Patch } from '../../lib/engine/types';

/**
 * The drawer's own drag: reordering a patch inside its section, re-filing it
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
 * Scoped to the section the tile came from — a tile's place in another
 * category is a category change, which the refile drop handles instead.
 *
 * Markup contract: spread `{...drag.rootAttrs}` on the drawer root (the
 * `dragBack` watch, which must run before the window listener sees the same
 * event bubble). A patch section's container gets `reorderOver`/`reorderDrop`
 * plus `refileLeave`; a section header gets the `refile*` trio.
 *
 * The gesture reads its surroundings through the getter bag handed to the
 * constructor — never plain values, which JS would freeze at construction.
 */

/** The in-flight reorder: which section, which tile, and the section's ids in
    the order shown right now (the live preview the drop commits). */
export interface Reorder {
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

/** Whether this section can take the dragged patch: another patch section,
    and a patch of the user's own — a pack's read-only patch is filed by its
    pack and cannot be re-filed, exactly as its tile offers no tag button. */
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
    the preview is a snapshot of the section it was taken from. */
export function applyPreview(base: readonly DrawerPatch[], ids: readonly string[]): DrawerPatch[] {
  const byId = new Map(base.map((entry) => [entry.patch.id, entry]));
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
}

export class DrawerDrag {
  reorder = $state<Reorder | null>(null);
  /** The section a reorder drag would re-file into if released right now —
      drawn highlighted so the header answers before the drop commits. */
  refileKey = $state<string | null>(null);

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

  /** Deliberately not `$state`: written on every dragover, and nothing
      renders it. */
  #hoverKey: string | null = null;
  #hoverTimer: ReturnType<typeof setTimeout> | undefined;
  #deps: DragDeps;

  constructor(deps: DragDeps) {
    this.#deps = deps;
  }

  get rootAttrs(): HTMLAttributes<HTMLDivElement> {
    return {
      ondragover: this.#backOver,
      ondragleave: this.#backLeave,
      ondrop: this.#clearBack,
      ondragend: this.#clearBack,
    };
  }

  /** A section's entries as displayed: the persisted hand order over the
      name-sorted list, overridden by the live preview while a reorder drag is
      over this section. */
  orderedEntries(section: PatchNode): DrawerPatch[] {
    const base = orderPatchEntries(section.entries, this.#deps.patchOrder()[section.key]);
    if (this.reorder?.sectionKey !== section.key) return base;
    return applyPreview(base, this.reorder.ids);
  }

  /** A plain drag left a tile for the rack, but stays armed for the mid-drag
      conversion — coming back over the drawer (see #convert). */
  armPlainDrag(sectionKey: string, patchId: string): void {
    this.#armed = { sectionKey, patchId };
    window.addEventListener('dragover', this.#convert);
  }

  startReorder(sectionKey: string, patchId: string): void {
    const section = this.#deps
      .sections()
      .find((s): s is PatchNode => s.kind === 'patches' && s.key === sectionKey);
    if (!section) return;
    this.reorder = {
      sectionKey,
      patchId,
      ids: orderPatchEntries(section.entries, this.#deps.patchOrder()[sectionKey]).map(
        (e) => e.patch.id,
      ),
    };
  }

  /** dragend from a plain (rack) drag: the armed conversion is torn down as
      well as the preview. Deliberately distinct from `endReorder`, because a
      tile reports one or the other and never both. */
  endPlainDrag(): void {
    window.removeEventListener('dragover', this.#convert);
    this.#armed = null;
    this.endReorder();
  }

  /** dragend from a reorder: fires after a landed drop's commit (the preview
      is already cleared then) and on its own for a drag released elsewhere,
      which snaps the preview back by discarding it. */
  endReorder(): void {
    this.reorder = null;
    this.refileKey = null;
    this.#cancelHoverOpen();
  }

  refileOver(e: DragEvent, section: DrawerSection): void {
    if (!this.#canRefile(section)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.refileKey = section.key;
    this.#armHoverOpen(section);
  }

  refileLeave(section: DrawerSection): void {
    if (this.refileKey === section.key) this.refileKey = null;
    if (this.#hoverKey === section.key) this.#cancelHoverOpen();
  }

  refileDrop(e: DragEvent, section: DrawerSection): void {
    if (!this.#canRefile(section) || section.kind !== 'patches') return;
    e.preventDefault();
    this.#deps.onSetPatchCategory(this.reorder!.patchId, section.label);
    this.refileKey = null;
    this.#cancelHoverOpen();
    this.reorder = null;
  }

  /** Live preview: as the drag crosses a tile, the dragged id moves before or
      after it depending on which half of the tile the pointer is in. */
  reorderOver(e: DragEvent, section: PatchNode): void {
    if (this.#canRefile(section)) return this.refileOver(e, section);
    const reorder = this.reorder;
    if (!reorder || reorder.sectionKey !== section.key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-reveal-id]');
    const overId = tile?.dataset.revealId;
    if (!tile || overId === undefined) return;
    const rect = tile.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const next = previewOrder(reorder.ids, reorder.patchId, overId, after);
    if (next) reorder.ids = next;
  }

  reorderDrop(e: DragEvent, section: PatchNode): void {
    if (this.#canRefile(section)) return this.refileDrop(e, section);
    if (!this.reorder || this.reorder.sectionKey !== section.key) return;
    e.preventDefault();
    this.#deps.onReorderPatches(this.reorder.sectionKey, this.reorder.ids);
    this.reorder = null;
  }

  /** The drawer is going away with a drag still armed (edit mode left); the
      window must not keep the conversion listener, nor a timer fire into a
      component that is gone. */
  destroy(): void {
    window.removeEventListener('dragover', this.#convert);
    this.#cancelHoverOpen();
  }

  #canRefile(section: DrawerSection): boolean {
    return canRefileInto(this.reorder, section, this.#deps.patches());
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
