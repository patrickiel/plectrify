/**
 * Knob grid geometry, shared by the engines (which own knob positions) and the
 * ModuleCard UI (which renders them).
 *
 * A module's knobs live on a 2-row grid that grows rightward. Each knob carries
 * a `pos` — a **column-major** cell index: the grid fills top then bottom of a
 * column before moving to the next one, so
 *   0 → (col 0, top)   1 → (col 0, bottom)
 *   2 → (col 1, top)   3 → (col 1, bottom)   …
 * Positions are sparse: a knob keeps its cell when others are added, removed, or
 * moved, and cells may be left empty. This is what lets a user park a knob in an
 * arbitrary slot without disturbing the rest.
 */

export const ROWS = 2;

/** The mapping-defining fields of a knob — everything a patch captures, minus
    live values and ids. Both live knobs (`MappedParam`) and saved patch knobs
    (`KnobDef`) satisfy this, so a patch and a module's current layout can be
    compared for equality. */
export interface SignableKnob {
  paramIndex: number;
  label: string;
  isMeter?: boolean;
  meterBipolar?: boolean;
  pos?: number;
}

/** Order-independent signature of a knob mapping, used to tell whether a
    module's current layout still matches the patch it was loaded from (the
    per-module equivalent of RigBar's dirty check). */
export function knobSignature(knobs: SignableKnob[]): string {
  return JSON.stringify(
    knobs
      .map((k) => ({
        paramIndex: k.paramIndex,
        label: k.label,
        isMeter: !!k.isMeter,
        meterBipolar: !!k.meterBipolar,
        pos: k.pos ?? null,
      }))
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.paramIndex - b.paramIndex),
  );
}

/** Grid cell (0-based col/row) for a column-major position. */
export function cellOf(pos: number): { col: number; row: number } {
  return { col: Math.floor(pos / ROWS), row: pos % ROWS };
}

/** The smallest non-negative cell index not present in `used`. */
export function firstFreePos(used: Iterable<number>): number {
  const taken = new Set(used);
  let p = 0;
  while (taken.has(p)) p++;
  return p;
}

/**
 * Fill in any missing/duplicate `pos` values, preserving existing ones. Old
 * persisted knobs (saved before positions existed) fall into free cells in
 * array order; already-positioned knobs are returned untouched. Idempotent.
 */
export function normalizePositions<T extends { pos?: number }>(items: T[]): T[] {
  const used = new Set<number>();
  return items.map((it) => {
    let pos = it.pos;
    if (pos === undefined || used.has(pos)) pos = firstFreePos(used);
    used.add(pos);
    return it.pos === pos ? it : { ...it, pos };
  });
}

/**
 * Move `knobId` to grid cell `pos`. If another knob already occupies that cell
 * they swap (the occupant takes the moved knob's old cell); if the cell is empty
 * the knob simply relocates, leaving its old cell free. All other knobs stay put.
 */
export function moveKnobToPos<T extends { knobId: string; pos?: number }>(
  items: T[],
  knobId: string,
  pos: number,
): T[] {
  const knobs = normalizePositions(items);
  const moved = knobs.find((k) => k.knobId === knobId);
  if (!moved || moved.pos === pos) return knobs;
  const from = moved.pos;
  return knobs.map((k) => {
    if (k.knobId === knobId) return { ...k, pos };
    if (k.pos === pos) return { ...k, pos: from }; // occupant swaps into the vacated cell
    return k;
  });
}
