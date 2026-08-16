import { describe, expect, it } from 'vitest';
import { NEEDLE_PRECISIONS } from '../../lib/engine/appSettings';
import { NEEDLE_RANGE_CENTS, NEEDLE_TICK_CENTS, needleOffset, needleTickPercents } from './needle';

describe('needleOffset', () => {
  it('is the identity at ×1', () => {
    for (const cents of [-50, -25, -5, 0, 3, 25, 50]) {
      expect(needleOffset(cents, 1)).toBe(cents);
    }
  });

  it('pins zero and full deflection at every precision', () => {
    for (const precision of NEEDLE_PRECISIONS) {
      expect(needleOffset(0, precision)).toBe(0);
      expect(needleOffset(NEEDLE_RANGE_CENTS, precision)).toBeCloseTo(NEEDLE_RANGE_CENTS, 10);
      expect(needleOffset(-NEEDLE_RANGE_CENTS, precision)).toBeCloseTo(-NEEDLE_RANGE_CENTS, 10);
    }
  });

  it('is odd: sharp and flat deflect symmetrically', () => {
    for (const precision of NEEDLE_PRECISIONS) {
      for (const cents of [1, 5, 12.5, 25, 40]) {
        expect(needleOffset(-cents, precision)).toBeCloseTo(-needleOffset(cents, precision), 10);
      }
    }
  });

  it('increases strictly with cents, so order on the scale is order in pitch', () => {
    for (const precision of NEEDLE_PRECISIONS) {
      let previous = needleOffset(-50, precision);
      for (let cents = -49; cents <= 50; cents++) {
        const offset = needleOffset(cents, precision);
        expect(offset).toBeGreaterThan(previous);
        previous = offset;
      }
    }
  });

  it('magnifies the centre by roughly the advertised factor', () => {
    // The slope at zero is the magnification; a small step approximates it.
    for (const precision of [2, 4] as const) {
      const slope = needleOffset(0.01, precision) / 0.01;
      expect(slope).toBeGreaterThan(precision * 0.9);
      expect(slope).toBeLessThan(precision * 1.1);
    }
  });

  it('gives ±5c more width than the outer 40..50c band once magnified', () => {
    for (const precision of [2, 4] as const) {
      const centreBand = 2 * needleOffset(5, precision);
      const outerBand = needleOffset(50, precision) - needleOffset(40, precision);
      expect(centreBand).toBeGreaterThan(outerBand);
    }
  });

  it('clamps readings past the scale to full deflection', () => {
    for (const precision of NEEDLE_PRECISIONS) {
      expect(needleOffset(80, precision)).toBeCloseTo(NEEDLE_RANGE_CENTS, 10);
      expect(needleOffset(-80, precision)).toBeCloseTo(-NEEDLE_RANGE_CENTS, 10);
    }
  });
});

describe('needleTickPercents', () => {
  it('marks the linear quarters at ×1', () => {
    expect(needleTickPercents(1)).toEqual({ lo: 25, hi: 75 });
  });

  it('stays mirrored around the centre line', () => {
    for (const precision of NEEDLE_PRECISIONS) {
      const { lo, hi } = needleTickPercents(precision);
      expect(lo + hi).toBeCloseTo(100, 10);
    }
  });

  it('slides outward as the centre magnifies, still marking ±25c', () => {
    let previousLo = needleTickPercents(1).lo;
    for (const precision of [2, 4] as const) {
      const { lo, hi } = needleTickPercents(precision);
      expect(lo).toBeLessThan(previousLo);
      expect(hi - 50).toBeCloseTo(needleOffset(NEEDLE_TICK_CENTS, precision), 10);
      previousLo = lo;
    }
  });
});
