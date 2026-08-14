import { describe, expect, it } from 'vitest';
import {
  cellOf,
  firstFreePos,
  knobSignature,
  moveKnobToPos,
  normalizePositions,
} from './knobLayout';

describe('cellOf', () => {
  it('maps column-major positions onto the 2-row grid', () => {
    expect(cellOf(0)).toEqual({ col: 0, row: 0 });
    expect(cellOf(1)).toEqual({ col: 0, row: 1 });
    expect(cellOf(2)).toEqual({ col: 1, row: 0 });
    expect(cellOf(5)).toEqual({ col: 2, row: 1 });
  });
});

describe('firstFreePos', () => {
  it('returns 0 for an empty grid', () => {
    expect(firstFreePos([])).toBe(0);
  });

  it('returns the smallest gap', () => {
    expect(firstFreePos([0, 1, 3])).toBe(2);
    expect(firstFreePos([1, 2])).toBe(0);
  });
});

describe('normalizePositions', () => {
  it('fills missing positions in array order', () => {
    const input: Array<{ id: string; pos?: number }> = [{ id: 'a' }, { id: 'b' }];
    const knobs = normalizePositions(input);
    expect(knobs.map((k) => k.pos)).toEqual([0, 1]);
  });

  it('preserves existing positions and resolves duplicates', () => {
    const knobs = normalizePositions([
      { id: 'a', pos: 3 },
      { id: 'b', pos: 3 }, // duplicate falls into the first free cell
      { id: 'c' },
    ]);
    expect(knobs.map((k) => k.pos)).toEqual([3, 0, 1]);
  });

  it('is idempotent and keeps object identity for untouched knobs', () => {
    const input = [
      { id: 'a', pos: 2 },
      { id: 'b', pos: 0 },
    ];
    const once = normalizePositions(input);
    expect(once[0]).toBe(input[0]);
    expect(once[1]).toBe(input[1]);
    expect(normalizePositions(once)).toEqual(once);
  });
});

describe('moveKnobToPos', () => {
  const knobs = [
    { knobId: 'a', pos: 0 },
    { knobId: 'b', pos: 1 },
  ];

  it('relocates into an empty cell, freeing the old one', () => {
    const moved = moveKnobToPos(knobs, 'a', 4);
    expect(moved.find((k) => k.knobId === 'a')?.pos).toBe(4);
    expect(moved.find((k) => k.knobId === 'b')?.pos).toBe(1);
  });

  it('swaps with an occupant', () => {
    const moved = moveKnobToPos(knobs, 'a', 1);
    expect(moved.find((k) => k.knobId === 'a')?.pos).toBe(1);
    expect(moved.find((k) => k.knobId === 'b')?.pos).toBe(0);
  });

  it('is a no-op for the current cell or an unknown knob', () => {
    expect(moveKnobToPos(knobs, 'a', 0)).toEqual(knobs);
    expect(moveKnobToPos(knobs, 'missing', 3)).toEqual(knobs);
  });
});

describe('knobSignature', () => {
  it('is order-independent', () => {
    const a = [
      { paramIndex: 1, label: 'Gain', pos: 0 },
      { paramIndex: 2, label: 'Tone', pos: 1, isMeter: true },
    ];
    const b = [a[1], a[0]];
    expect(knobSignature(a)).toBe(knobSignature(b));
  });

  it('changes when a mapping-defining field changes', () => {
    const base = [{ paramIndex: 1, label: 'Gain', pos: 0 }];
    expect(knobSignature(base)).not.toBe(knobSignature([{ ...base[0], label: 'Drive' }]));
    expect(knobSignature(base)).not.toBe(knobSignature([{ ...base[0], isMeter: true }]));
    expect(knobSignature(base)).not.toBe(knobSignature([{ ...base[0], pos: 1 }]));
  });

  it('treats explicit false flags like absent ones', () => {
    const implicit = [{ paramIndex: 1, label: 'Gain', pos: 0 }];
    const explicit = [
      { paramIndex: 1, label: 'Gain', pos: 0, isMeter: false, meterBipolar: false },
    ];
    expect(knobSignature(implicit)).toBe(knobSignature(explicit));
  });
});
