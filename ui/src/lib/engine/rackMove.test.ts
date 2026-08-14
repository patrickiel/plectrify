import { describe, expect, it } from 'vitest';
import { moveModuleInRack, resolveInsert, swapModulesInRack } from './rackMove';
import type { RackModule, SplitGroup } from './types';

// Minimal builders: only the fields the move arithmetic reads.
const mod = (id: string, laneId?: string): RackModule => ({
  id,
  name: id,
  bypassed: false,
  params: [],
  availableParams: [],
  ...(laneId ? { laneId } : {}),
});

const group = (
  id: string,
  position: number,
  laneIds: string[],
  activeLaneId?: string,
): SplitGroup => ({
  id,
  position,
  activeLaneId,
  lanes: laneIds.map((laneId) => ({
    id: laneId,
    name: laneId,
    gain: 1,
    pan: 0,
    muted: false,
    soloed: false,
  })),
});

const ids = (rack: RackModule[]) => rack.map((m) => m.id);
const serialIds = (rack: RackModule[]) => rack.filter((m) => !m.laneId).map((m) => m.id);
const laneIds = (rack: RackModule[], laneId: string) =>
  rack.filter((m) => m.laneId === laneId).map((m) => m.id);
const positions = (groups: SplitGroup[]) => groups.map((g) => g.position);

describe('resolveInsert', () => {
  it('resolves serial gaps to the flat index of the pos-th serial module', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2'])];
    // Gap before b sits after the lane module in the flat array.
    expect(resolveInsert(rack, groups, { serialPosition: 1 })).toMatchObject({
      insertAt: 2,
      laneId: undefined,
    });
    // Past the last serial module means the end of the rack.
    expect(resolveInsert(rack, groups, { serialPosition: 2 })).toMatchObject({ insertAt: 3 });
  });

  it('bumps only the groups after the gap; beforeGroupId flips a co-located group', () => {
    const groups = [group('g1', 1, ['l1', 'l2']), group('g2', 1, ['l3', 'l4'])];
    const rack = [mod('a'), mod('b')];
    // Without beforeGroupId the module lands after both co-located splits.
    expect(positions(resolveInsert(rack, groups, { serialPosition: 1 })!.groups)).toEqual([1, 1]);
    // Naming g2 puts the module between the splits: only g2 bumps.
    expect(
      positions(resolveInsert(rack, groups, { serialPosition: 1, beforeGroupId: 'g2' })!.groups),
    ).toEqual([1, 2]);
    // Naming g1 puts it before both.
    expect(
      positions(resolveInsert(rack, groups, { serialPosition: 1, beforeGroupId: 'g1' })!.groups),
    ).toEqual([2, 2]);
  });

  it('resolves lane gaps by anchor and rejects unknown lanes', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('y', 'l1')];
    const groups = [group('g1', 1, ['l1', 'l2'])];
    expect(resolveInsert(rack, groups, { laneId: 'l1', beforeModuleId: 'y' })).toMatchObject({
      insertAt: 2,
      laneId: 'l1',
    });
    // No anchor: end of the lane, represented as the end of the rack.
    expect(resolveInsert(rack, groups, { laneId: 'l1' })).toMatchObject({ insertAt: 3 });
    // A stale anchor that is not in the target lane falls back to the end too.
    expect(resolveInsert(rack, groups, { laneId: 'l1', beforeModuleId: 'a' })).toMatchObject({
      insertAt: 3,
    });
    expect(resolveInsert(rack, groups, { laneId: 'nope' })).toBeNull();
  });
});

describe('moveModuleInRack: serial ↔ serial', () => {
  it('moves rightward within a segment (pre-move coordinates)', () => {
    // The gap after c is serialPosition 3 in pre-move coordinates; detaching a
    // shifts it to 2. Wrong adjustment would land a before c.
    const rack = [mod('a'), mod('b'), mod('c')];
    const result = moveModuleInRack(rack, [], 'a', { serialPosition: 3 });
    expect(result.changed).toBe(true);
    expect(ids(result.rack)).toEqual(['b', 'c', 'a']);
  });

  it('crosses a split boundary in both directions with position fixups', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2'])];

    // b jumps to the head of the chain: the split now has two serial modules
    // after it… meaning its preceding count grows by one.
    const back = moveModuleInRack(rack, groups, 'b', { serialPosition: 0 });
    expect(serialIds(back.rack)).toEqual(['b', 'a']);
    expect(positions(back.groups)).toEqual([2]);

    // a jumps past the split into the tail segment.
    const forward = moveModuleInRack(rack, groups, 'a', { serialPosition: 2 });
    expect(serialIds(forward.rack)).toEqual(['b', 'a']);
    expect(positions(forward.groups)).toEqual([0]);
  });

  it('lands on the near side of a split when beforeGroupId names it', () => {
    const rack = [mod('a'), mod('b')];
    const groups = [group('g1', 2, ['l1', 'l2'])];
    // Gap after b, before the split (pre-move serialPosition 2, beforeGroupId).
    const result = moveModuleInRack(rack, groups, 'a', { serialPosition: 2, beforeGroupId: 'g1' });
    expect(serialIds(result.rack)).toEqual(['b', 'a']);
    expect(positions(result.groups)).toEqual([2]);

    // Same gap index without beforeGroupId: after the split instead.
    const after = moveModuleInRack(rack, groups, 'a', { serialPosition: 2 });
    expect(serialIds(after.rack)).toEqual(['b', 'a']);
    expect(positions(after.groups)).toEqual([1]);
  });
});

describe('moveModuleInRack: serial ↔ lane', () => {
  it('serial → lane decrements later group positions', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2'])];
    // a leaves the serial chain for the (empty) lane l2.
    const result = moveModuleInRack(rack, groups, 'a', { laneId: 'l2' });
    expect(result.changed).toBe(true);
    expect(serialIds(result.rack)).toEqual(['b']);
    expect(laneIds(result.rack, 'l2')).toEqual(['a']);
    expect(positions(result.groups)).toEqual([0]);
  });

  it('lane → serial increments later group positions', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2'])];

    // x rejoins the chain before the split it fanned out of.
    const before = moveModuleInRack(rack, groups, 'x', { serialPosition: 1, beforeGroupId: 'g1' });
    expect(serialIds(before.rack)).toEqual(['a', 'x', 'b']);
    expect(laneIds(before.rack, 'l1')).toEqual([]);
    expect(positions(before.groups)).toEqual([2]);

    // …or after it.
    const after = moveModuleInRack(rack, groups, 'x', { serialPosition: 1 });
    expect(serialIds(after.rack)).toEqual(['a', 'x', 'b']);
    expect(positions(after.groups)).toEqual([1]);
  });
});

describe('moveModuleInRack: lane ↔ lane', () => {
  it('moves between lanes of different groups', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b'), mod('y', 'l3')];
    const groups = [group('g1', 1, ['l1', 'l2']), group('g2', 2, ['l3', 'l4'])];
    const result = moveModuleInRack(rack, groups, 'x', { laneId: 'l3', beforeModuleId: 'y' });
    expect(laneIds(result.rack, 'l1')).toEqual([]);
    expect(laneIds(result.rack, 'l3')).toEqual(['x', 'y']);
    // Lane→lane touches no serial counts.
    expect(positions(result.groups)).toEqual([1, 2]);
  });

  it('orders within a lane via beforeModuleId and end-of-lane', () => {
    const rack = [mod('x', 'l1'), mod('y', 'l1'), mod('z', 'l1')];
    const groups = [group('g1', 0, ['l1', 'l2'])];
    const toFront = moveModuleInRack(rack, groups, 'z', { laneId: 'l1', beforeModuleId: 'x' });
    expect(laneIds(toFront.rack, 'l1')).toEqual(['z', 'x', 'y']);
    const toEnd = moveModuleInRack(rack, groups, 'x', { laneId: 'l1' });
    expect(laneIds(toEnd.rack, 'l1')).toEqual(['y', 'z', 'x']);
  });
});

describe('moveModuleInRack: no-ops and invalid targets', () => {
  it('rejects unknown module and unknown lane', () => {
    const rack = [mod('a')];
    expect(moveModuleInRack(rack, [], 'nope', { serialPosition: 0 }).changed).toBe(false);
    expect(moveModuleInRack(rack, [], 'a', { laneId: 'nope' }).changed).toBe(false);
  });

  it('treats the module’s own adjacent gaps as no-ops (serial)', () => {
    const rack = [mod('a'), mod('b'), mod('c')];
    // Both gaps flanking b resolve back to its own spot.
    expect(moveModuleInRack(rack, [], 'b', { serialPosition: 1 }).changed).toBe(false);
    expect(moveModuleInRack(rack, [], 'b', { serialPosition: 2 }).changed).toBe(false);
  });

  it('treats the module’s own adjacent gaps as no-ops (lane)', () => {
    const rack = [mod('x', 'l1'), mod('y', 'l1')];
    const groups = [group('g1', 0, ['l1', 'l2'])];
    // Before itself…
    expect(moveModuleInRack(rack, groups, 'x', { laneId: 'l1', beforeModuleId: 'x' }).changed).toBe(
      false,
    );
    // …and before its own successor.
    expect(moveModuleInRack(rack, groups, 'x', { laneId: 'l1', beforeModuleId: 'y' }).changed).toBe(
      false,
    );
    // Last module dropped on the end-of-lane gap.
    expect(moveModuleInRack(rack, groups, 'y', { laneId: 'l1' }).changed).toBe(false);
  });

  it('returns the untouched inputs on a no-op', () => {
    const rack = [mod('a'), mod('b')];
    const groups = [group('g1', 2, ['l1', 'l2'])];
    const result = moveModuleInRack(rack, groups, 'a', { serialPosition: 0 });
    expect(result.changed).toBe(false);
    expect(result.rack).toBe(rack);
    expect(result.groups).toBe(groups);
  });

  it('treats own gaps as no-ops even with lane modules interleaved (flat-index trap)', () => {
    // b's serial successor gap is not flat-adjacent (x sits after b in the
    // flat array): index-based no-op detection resolved this to a different
    // flat index and committed a move that corrupted g1's position to 1 and
    // shuffled the flat order.
    const rack = [mod('a'), mod('b'), mod('x', 'l1')];
    const groups = [group('g1', 2, ['l1', 'l2'])];
    const before = moveModuleInRack(rack, groups, 'b', { serialPosition: 1 });
    expect(before.changed).toBe(false);
    expect(before.rack).toBe(rack);
    // The gap after b names the co-located split it stops short of.
    const after = moveModuleInRack(rack, groups, 'b', { serialPosition: 2, beforeGroupId: 'g1' });
    expect(after.changed).toBe(false);
    expect(after.groups).toBe(groups);
  });

  it('does not swallow a real move that lands on the same flat index', () => {
    // m sits directly after the split; dropping it on the before-split gap
    // changes only the group position — the flat order stays identical, which
    // index-based detection misread as a no-op and swallowed.
    const rack = [mod('a'), mod('x', 'l1'), mod('m')];
    const groups = [group('g1', 1, ['l1', 'l2'])];
    const result = moveModuleInRack(rack, groups, 'm', { serialPosition: 1, beforeGroupId: 'g1' });
    expect(result.changed).toBe(true);
    expect(serialIds(result.rack)).toEqual(['a', 'm']);
    expect(positions(result.groups)).toEqual([2]);
    // …and the plain after-split gap moves it back across.
    const inverse = moveModuleInRack(result.rack, result.groups, 'm', { serialPosition: 2 });
    expect(inverse.changed).toBe(true);
    expect(positions(inverse.groups)).toEqual([1]);
  });

  it('treats a lane no-op as such when the lane interleaves with serial modules', () => {
    // l1 = [x, y] with serial s between them in the flat array: the old
    // index-based guard would have committed a flat-order shuffle here.
    const rack = [mod('x', 'l1'), mod('s'), mod('y', 'l1')];
    const groups = [group('g1', 0, ['l1', 'l2'])];
    const result = moveModuleInRack(rack, groups, 'x', { laneId: 'l1', beforeModuleId: 'y' });
    expect(result.changed).toBe(false);
    expect(result.rack).toBe(rack);
  });
});

describe('moveModuleInRack: emptied lanes stay', () => {
  it('leaves the source lane empty but alive (no dissolve, positions intact)', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('y', 'l2'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2']), group('g2', 2, ['l3', 'l4'])];
    // x was l1's only module; moving it out must not delete l1 or dissolve g1.
    const result = moveModuleInRack(rack, groups, 'x', { laneId: 'l3' });
    expect(laneIds(result.rack, 'l1')).toEqual([]);
    expect(laneIds(result.rack, 'l3')).toEqual(['x']);
    expect(result.groups.map((g) => g.lanes.length)).toEqual([2, 2]);
    expect(positions(result.groups)).toEqual([1, 2]);
  });

  it('moves into a freshly appended lane (the new-lane path)', () => {
    // The engine appends the minted lane before calling moveModuleInRack; the
    // anchor-less lane target then lands the module at the end of it.
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2', 'l3'])];
    const result = moveModuleInRack(rack, groups, 'x', { laneId: 'l3' });
    expect(laneIds(result.rack, 'l1')).toEqual([]);
    expect(laneIds(result.rack, 'l3')).toEqual(['x']);
    expect(result.groups[0].lanes.length).toBe(3);
  });
});

describe('resolveInsert as insertModule’s resolver (refactor regression)', () => {
  it('matches the previous inline serial behavior', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const groups = [group('g1', 1, ['l1', 'l2'])];
    const resolved = resolveInsert(rack, groups, { serialPosition: 1, beforeGroupId: 'g1' })!;
    expect(resolved.insertAt).toBe(2);
    expect(positions(resolved.groups)).toEqual([2]);
  });

  it('clamps out-of-range serial positions', () => {
    const rack = [mod('a')];
    expect(resolveInsert(rack, [], { serialPosition: 99 })!.insertAt).toBe(1);
    expect(resolveInsert(rack, [], { serialPosition: -5 })!.insertAt).toBe(0);
  });
});

describe('swapModulesInRack', () => {
  it('exchanges two serial modules and leaves every group position alone', () => {
    const rack = [mod('a'), mod('b'), mod('c')];
    const groups = [group('g1', 2, ['l1', 'l2'])];
    const result = swapModulesInRack(rack, 'a', 'c');
    expect(result.changed).toBe(true);
    expect(ids(result.rack)).toEqual(['c', 'b', 'a']);
    // Nothing structural moved, so the caller's groups need no fixup at all.
    expect(positions(groups)).toEqual([2]);
  });

  it('trades a serial module with one inside a lane, each taking the other’s place', () => {
    const rack = [mod('a'), mod('x', 'l1'), mod('b')];
    const result = swapModulesInRack(rack, 'a', 'x');
    expect(ids(result.rack)).toEqual(['x', 'a', 'b']);
    // The place keeps its lane tag: 'a' is now the lane's module, 'x' serial.
    expect(serialIds(result.rack)).toEqual(['x', 'b']);
    expect(laneIds(result.rack, 'l1')).toEqual(['a']);
  });

  it('trades modules across two lanes of the same split', () => {
    const rack = [mod('x', 'l1'), mod('y', 'l2')];
    const result = swapModulesInRack(rack, 'x', 'y');
    expect(laneIds(result.rack, 'l1')).toEqual(['y']);
    expect(laneIds(result.rack, 'l2')).toEqual(['x']);
  });

  it('is a no-op for the same module, or an id the rack does not hold', () => {
    const rack = [mod('a'), mod('b')];
    expect(swapModulesInRack(rack, 'a', 'a').changed).toBe(false);
    expect(swapModulesInRack(rack, 'a', 'gone').changed).toBe(false);
    expect(swapModulesInRack(rack, 'a', 'gone').rack).toBe(rack);
  });
});
