import { describe, expect, it } from 'vitest';
import { MAX_TAPS, registerTap, TAP_TIMEOUT_MS } from './tapTempo';

describe('registerTap', () => {
  it('needs two taps and measures their average interval', () => {
    expect(registerTap([], 0)).toEqual({ taps: [0], bpm: null });
    expect(registerTap([0], 500).bpm).toBe(120);
    expect(registerTap([0, 500, 1000, 1500], 2000).bpm).toBe(120);
  });

  it('keeps only the latest tap window', () => {
    const result = registerTap([0, 500, 1000, 1500, 2000], 2500);
    expect(result.taps).toHaveLength(MAX_TAPS);
    expect(result.taps[0]).toBe(500);
  });

  it('restarts after a long gap', () => {
    expect(registerTap([0, 500], 500 + TAP_TIMEOUT_MS + 1)).toEqual({
      taps: [500 + TAP_TIMEOUT_MS + 1],
      bpm: null,
    });
  });

  it('clamps absurd rates to the supported range', () => {
    expect(registerTap([0], 10).bpm).toBe(240);
    expect(registerTap([0], 1900).bpm).toBe(40);
  });
});
