import type { ModuleInsertTarget } from './EngineBridge';
import type { RackModule, SplitGroup } from './types';

/**
 * Pure insert/move arithmetic over the flat rack array and split groups.
 *
 * The rack is one flat ordered array; lane membership is a `laneId` tag and
 * `SplitGroup.position` counts the serial-only modules preceding a split. All
 * index bookkeeping for inserting and moving modules lives here so
 * `MockEngine.insertModule` and `MockEngine.moveModule` resolve positions with
 * the same code and can never drift apart. The C++ engine mirrors this
 * arithmetic in `RackProcessor::moveSlot` / `addPlugin` — keep both sides in
 * step when changing anything here.
 */

export interface ResolvedInsert {
  /** Flat splice index into the rack array. */
  insertAt: number;
  /** Lane the inserted module belongs to; undefined for the serial chain. */
  laneId: string | undefined;
  /** Group list with the insertion's position fixups applied. */
  groups: SplitGroup[];
}

/** Resolve an insert target to a flat splice index plus the group positions
    after the insertion's fixups. Returns null when the target names a lane
    that no longer exists. */
export function resolveInsert(
  rack: RackModule[],
  groups: SplitGroup[],
  target: ModuleInsertTarget,
): ResolvedInsert | null {
  if (target.laneId) {
    const laneExists = groups.some((group) =>
      group.lanes.some((lane) => lane.id === target.laneId),
    );
    if (!laneExists) return null;

    // Lane gaps anchor on the module they precede; no anchor means the end of
    // the lane, which the flat array represents as the end of the rack.
    const anchorIndex = target.beforeModuleId
      ? rack.findIndex(
          (candidate) =>
            candidate.id === target.beforeModuleId && candidate.laneId === target.laneId,
        )
      : -1;
    return {
      insertAt: anchorIndex >= 0 ? anchorIndex : rack.length,
      laneId: target.laneId,
      groups,
    };
  }

  const serial = rack.filter((candidate) => !candidate.laneId);
  const pos = Math.max(0, Math.min(serial.length, target.serialPosition ?? serial.length));
  const anchor = serial[pos];
  const insertAt = anchor ? rack.indexOf(anchor) : rack.length;
  const beforeGroupIndex = target.beforeGroupId
    ? groups.findIndex((group) => group.id === target.beforeGroupId)
    : -1;

  // Groups after the gap gain one preceding serial module. A group sitting
  // exactly at the gap stays before the new module unless `beforeGroupId`
  // names it (or an earlier co-located group), which puts the module on the
  // near side of the split instead.
  return {
    insertAt,
    laneId: undefined,
    groups: groups.map((group, index) => {
      const followsInsertion =
        group.position > pos ||
        (group.position === pos && beforeGroupIndex >= 0 && index >= beforeGroupIndex);
      return followsInsertion ? { ...group, position: group.position + 1 } : group;
    }),
  };
}

export interface RackMoveResult {
  rack: RackModule[];
  groups: SplitGroup[];
  /** False when the target was invalid or resolved to the module's own spot;
      `rack`/`groups` are then the untouched inputs. */
  changed: boolean;
}

/** Move an existing module to an insert gap (an existing lane or the serial
    chain — new-lane moves append the lane first and target it as a normal
    lane). `target` is in pre-move coordinates: the UI computes gaps from the
    rendered rack, so `serialPosition` must be adjusted once the module's own
    removal shifts the serial sequence. */
export function moveModuleInRack(
  rack: RackModule[],
  groups: SplitGroup[],
  moduleId: string,
  target: ModuleInsertTarget,
): RackMoveResult {
  const unchanged: RackMoveResult = { rack, groups, changed: false };
  const from = rack.findIndex((candidate) => candidate.id === moduleId);
  if (from < 0) return unchanged;
  // "Before yourself" is a no-op by definition — and after detaching, the
  // anchor lookup could no longer find the module anyway.
  if (target.beforeModuleId === moduleId) return unchanged;

  const moved = rack[from];
  const oldLaneId = moved.laneId;
  const oldSerialIndex = oldLaneId
    ? -1
    : rack.slice(0, from).filter((candidate) => !candidate.laneId).length;

  // --- Semantic no-op detection, before any mutation -----------------------
  // Flat indices are not a reliable no-op test: lane modules interleave with
  // serial modules in the flat array, so a drop into the module's own logical
  // gap can resolve to a different flat index (which would commit a move that
  // corrupts group positions and shuffles the flat order) while a real move
  // across an adjacent split can resolve to the module's own index (which
  // would be swallowed). Classify by signal-path meaning instead. Mirrored in
  // RackProcessor::moveSlot — keep both sides in step.
  if (!oldLaneId && !target.laneId) {
    const serialCountPre = rack.filter((candidate) => !candidate.laneId).length;
    const p = Math.max(0, Math.min(serialCountPre, target.serialPosition ?? serialCountPre));
    // The gap directly before the module (or after a split directly before
    // it). With beforeGroupId the drop crosses that split — a real move.
    if (p === oldSerialIndex && !target.beforeGroupId) return unchanged;
    if (p === oldSerialIndex + 1) {
      const firstFollower = groups.find((group) => group.position === p);
      // The gap directly after the module: plain when no split follows, or
      // naming the directly-following split it stops short of. Without
      // beforeGroupId while a split IS there, the drop means the split's far
      // side — a real move.
      if (!target.beforeGroupId && !firstFollower) return unchanged;
      if (target.beforeGroupId && firstFollower?.id === target.beforeGroupId) return unchanged;
    }
  } else if (oldLaneId && target.laneId === oldLaneId) {
    const successor = rack.slice(from + 1).find((candidate) => candidate.laneId === oldLaneId);
    // The end-of-lane gap under the last module, or the gap before the
    // module's own successor.
    if (!target.beforeModuleId && !successor) return unchanged;
    if (target.beforeModuleId && successor?.id === target.beforeModuleId) return unchanged;
  }

  // Detach: the working state the insert resolution runs against. A serial
  // module leaving the chain takes one preceding module away from every
  // later group (the exact mirror of removeModule's fixup).
  const detachedRack = rack.filter((_, index) => index !== from);
  const detachedGroups = oldLaneId
    ? groups
    : groups.map((group) =>
        group.position > oldSerialIndex ? { ...group, position: group.position - 1 } : group,
      );

  // Pre-move → detached coordinates: serial gaps past the module's old spot
  // shift down by one once it is detached. Anchors are ids and need no
  // adjustment.
  let serialPosition = target.serialPosition;
  if (serialPosition !== undefined && !oldLaneId && serialPosition > oldSerialIndex)
    serialPosition -= 1;

  const resolved = resolveInsert(detachedRack, detachedGroups, { ...target, serialPosition });
  if (!resolved) return unchanged;

  const movedModule = { ...moved };
  if (resolved.laneId) movedModule.laneId = resolved.laneId;
  else delete movedModule.laneId;

  const nextRack = [...detachedRack];
  nextRack.splice(resolved.insertAt, 0, movedModule);
  return { rack: nextRack, groups: resolved.groups, changed: true };
}

export interface RackSwapResult {
  rack: RackModule[];
  /** False when either id is unknown or both name the same module; `rack` is
      then the untouched input. */
  changed: boolean;
}

/** Exchange two modules' places in the chain — each lands exactly where the
    other was, keeping its own id and everything keyed to it.
 *
 * Deliberately *not* two moves. The pair of positions is fixed, so the flat
 * array's lane tags read the same afterwards as before and every group's
 * position — a count of the serial modules preceding it — is untouched. That
 * is why this needs no split arithmetic at all, and why it works unchanged
 * across a split boundary: only the two payloads change hands, never the
 * structure they sit in. Each place keeps its own `laneId`, so a serial module
 * traded with one inside a lane really does enter that lane.
 *
 * Mirrored by `RackProcessor::swapSlots` — keep the two in step. */
export function swapModulesInRack(
  rack: RackModule[],
  moduleIdA: string,
  moduleIdB: string,
): RackSwapResult {
  const unchanged: RackSwapResult = { rack, changed: false };
  if (moduleIdA === moduleIdB) return unchanged;
  const a = rack.findIndex((candidate) => candidate.id === moduleIdA);
  const b = rack.findIndex((candidate) => candidate.id === moduleIdB);
  if (a < 0 || b < 0) return unchanged;

  const next = [...rack];
  next[a] = inLane(rack[b], rack[a].laneId);
  next[b] = inLane(rack[a], rack[b].laneId);
  return { rack: next, changed: true };
}

/** A copy of `module` tagged for `laneId`, with the tag *absent* rather than
    undefined when the place is serial — the flat array's own convention. */
function inLane(module: RackModule, laneId: string | undefined): RackModule {
  const next = { ...module };
  if (laneId === undefined) delete next.laneId;
  else next.laneId = laneId;
  return next;
}
