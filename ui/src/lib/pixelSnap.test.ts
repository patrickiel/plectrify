import { describe, expect, it } from 'vitest';
import { deviceScale, snapCenter, snapEdge, snapThickness } from './pixelSnap';

// Windows display scaling (1, 1.25, 1.5, 1.75, 2) crossed with the rack's zoom
// steps. The awkward ones are the point: 2 x 1.75 is 3.5 device pixels, which no
// amount of positioning can make crisp.
const SCALES = [0.1, 0.5, 0.8, 1, 1.25, 1.5, 1.75, 1.875, 2, 2.5, 3, 4.5, 5.25];
const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;
const isHalf = (value: number) => isWhole(value - 0.5);

describe('deviceScale', () => {
  it('multiplies the display ratio by the zoom', () => {
    expect(deviceScale(1, 1)).toBe(1);
    expect(deviceScale(1.25, 2)).toBe(2.5);
    expect(deviceScale(1.5, 0.5)).toBe(0.75);
  });

  it('falls back to 1:1 rather than producing a scale that blanks every line', () => {
    expect(deviceScale(NaN, 1)).toBe(1);
    expect(deviceScale(1, 0)).toBe(1);
    expect(deviceScale(0, 0)).toBe(1);
    expect(deviceScale(Infinity, 1)).toBe(1);
  });
});

describe('snapThickness', () => {
  it('leaves a 2px line alone wherever 2 already covers whole device pixels', () => {
    expect(snapThickness(2, 1)).toBe(2);
    expect(snapThickness(2, 0.5)).toBe(2);
    expect(snapThickness(2, 1.5)).toBe(2);
    expect(snapThickness(2, 2)).toBe(2);
    expect(snapThickness(2, 4.5)).toBe(2);
  });

  // Pins the "ties round heavier" decision: 2 x 1.25 = 2.5 device px could go
  // either way, and we take 3 (2.4 local px) so the route reads slightly bold
  // at 125% scaling rather than slightly thin.
  it('rounds a tie up to the heavier line', () => {
    expect(snapThickness(2, 1.25)).toBeCloseTo(2.4, 10);
    expect(snapThickness(2, 1.25) * 1.25).toBeCloseTo(3, 10);
  });

  it('clamps to a one-device-pixel hairline when zoomed far out', () => {
    expect(snapThickness(2, 0.1)).toBe(10);
    expect(snapThickness(2, 0.2)).toBe(5);
  });

  it('always covers a whole number of device pixels', () => {
    for (const scale of SCALES) {
      const devicePixels = snapThickness(2, scale) * scale;
      expect(isWhole(devicePixels)).toBe(true);
      expect(devicePixels).toBeGreaterThanOrEqual(1);
    }
  });

  it('is idempotent and survives garbage', () => {
    for (const scale of SCALES) {
      const once = snapThickness(2, scale);
      expect(snapThickness(once, scale)).toBeCloseTo(once, 10);
    }
    expect(snapThickness(NaN, 1)).toBe(1);
    expect(snapThickness(2, NaN)).toBe(2);
  });
});

describe('snapEdge', () => {
  it('puts the edge on a whole device pixel', () => {
    for (const scale of SCALES) {
      for (const value of [0, 0.3, 7.04, 12.16, 123.5, -4.2]) {
        expect(isWhole(snapEdge(value, scale) * scale)).toBe(true);
      }
    }
  });

  it('keeps zero at zero and never moves a value more than half a device pixel', () => {
    for (const scale of SCALES) {
      expect(snapEdge(0, scale)).toBe(0);
      for (const value of [0.3, 7.04, 12.16, 123.5]) {
        expect(Math.abs(snapEdge(value, scale) - value)).toBeLessThanOrEqual(0.5 / scale + 1e-9);
      }
    }
  });

  it('is idempotent', () => {
    for (const scale of SCALES) {
      const once = snapEdge(12.16, scale);
      expect(snapEdge(once, scale)).toBeCloseTo(once, 10);
    }
  });
});

describe('snapCenter', () => {
  it('lands both edges of the band on whole device pixels', () => {
    for (const scale of SCALES) {
      const thickness = snapThickness(2, scale);
      for (const center of [0, 12.16, 82.5, 123.5, 400.37]) {
        const snapped = snapCenter(center, scale, thickness);
        expect(isWhole((snapped - thickness / 2) * scale)).toBe(true);
        expect(isWhole((snapped + thickness / 2) * scale)).toBe(true);
      }
    }
  });

  // The parity rule the whole helper exists for: an even band centres on a
  // device pixel boundary, an odd one has to centre mid-pixel.
  it('follows the parity of the band width', () => {
    for (const scale of SCALES) {
      const thickness = snapThickness(2, scale);
      const devicePixels = Math.round(thickness * scale);
      const centerDevice = snapCenter(82.5, scale, thickness) * scale;
      expect(devicePixels % 2 === 0 ? isWhole(centerDevice) : isHalf(centerDevice)).toBe(true);
    }
  });

  // Without an origin a centre is only snapped relative to its own container,
  // which is enough for a CSS box (the compositor re-snaps those) but leaves an
  // SVG stroke feathered by however far its element sits off the grid.
  it('lands the band on screen pixels when given the container origin', () => {
    for (const scale of SCALES) {
      const thickness = snapThickness(2, scale);
      const half = (thickness * scale) / 2;
      for (const origin of [0, 0.0625, 0.46875, 512.5, -13.25]) {
        for (const center of [12.16, 82.5, 400.37]) {
          const device = origin + snapCenter(center, scale, thickness, origin) * scale;
          expect(isWhole(device - half)).toBe(true);
          expect(isWhole(device + half)).toBe(true);
        }
      }
    }
  });

  it('is idempotent and never moves a centre more than half a device pixel', () => {
    for (const scale of SCALES) {
      const thickness = snapThickness(2, scale);
      const once = snapCenter(82.5, scale, thickness);
      expect(snapCenter(once, scale, thickness)).toBeCloseTo(once, 10);
      expect(Math.abs(once - 82.5)).toBeLessThanOrEqual(0.5 / scale + 1e-9);
    }
  });
});
