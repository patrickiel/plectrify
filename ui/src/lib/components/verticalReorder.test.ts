import { describe, expect, it } from 'vitest';
import { clampOffset, landingIndex, type Row } from './verticalReorder.svelte';

/** Four rows of 30px, stacked from y=0 — the shape of a rig/scene menu. */
const H = 30;
const rows: Row[] = Array.from({ length: 4 }, (_, i) => ({
  top: i * H,
  height: H,
  center: i * H + H / 2,
}));

/** Where a drag of `dy` px from `from` lands, clamping included. */
const drag = (from: number, dy: number) => landingIndex(rows, from, clampOffset(rows, from, dy));

describe('landingIndex', () => {
  it('stays put until the row is half a row past its neighbour', () => {
    expect(drag(1, H / 2 - 1)).toBe(1);
    expect(drag(1, H / 2 + 1)).toBe(2);
    expect(drag(1, -H / 2 + 1)).toBe(1);
    expect(drag(1, -H / 2 - 1)).toBe(0);
  });

  it('steps one slot at a time', () => {
    expect(drag(0, H)).toBe(1);
    expect(drag(0, 2 * H)).toBe(2);
    expect(drag(3, -H)).toBe(2);
    expect(drag(3, -2 * H)).toBe(1);
  });

  // The dragged row is clamped to the list, so at full travel its centre only
  // ever *meets* the end row's centre. Testing centres left both ends of the
  // list unreachable; the leading edge is what makes them reachable.
  it('reaches the last slot at full downward travel', () => {
    expect(drag(0, 10_000)).toBe(3);
    expect(drag(1, 10_000)).toBe(3);
  });

  it('reaches the first slot at full upward travel', () => {
    expect(drag(3, -10_000)).toBe(0);
    expect(drag(2, -10_000)).toBe(0);
  });
});

describe('clampOffset', () => {
  it('never lets the row leave the list', () => {
    expect(clampOffset(rows, 0, -500)).toBe(0);
    expect(clampOffset(rows, 0, 500)).toBe(3 * H);
    expect(clampOffset(rows, 3, -500)).toBe(-3 * H);
    expect(clampOffset(rows, 3, 500)).toBe(0);
  });
});
