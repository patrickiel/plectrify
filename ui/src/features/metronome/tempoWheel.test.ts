import { describe, expect, it } from 'vitest';
import { wheelDelta } from './tempoWheel';

describe('wheelDelta', () => {
  it('increases upward and rightward at two pixels per BPM', () => {
    expect(wheelDelta(0, -10, false)).toBe(5);
    expect(wheelDelta(10, 0, false)).toBe(5);
    expect(wheelDelta(0, 10, false)).toBe(-5);
  });

  it('uses shift for quarter-rate fine motion and preserves zero', () => {
    expect(wheelDelta(0, -8, true)).toBe(1);
    expect(wheelDelta(0, 0, false)).toBe(0);
  });
});
