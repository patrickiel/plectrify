import { describe, expect, it } from 'vitest';
import { cycleLevel, resizePattern, sanitizePattern, stepLevel } from './beatPattern';

describe('beatPattern', () => {
  it('cycles off, normal, accent and advances legacy soft to normal', () => {
    expect([0, 1, 2, 3].map((level) => cycleLevel(level as 0 | 1 | 2 | 3))).toEqual([2, 2, 3, 0]);
  });

  it('steps through the states and clamps at both ends', () => {
    expect(stepLevel(0, 1)).toBe(2);
    expect(stepLevel(2, 1)).toBe(3);
    expect(stepLevel(3, 1)).toBe(3);
    expect(stepLevel(3, -1)).toBe(2);
    expect(stepLevel(0, -1)).toBe(0);
    expect(stepLevel(1, -1)).toBe(0);
  });

  it('grows with normal beats and truncates without changing the downbeat', () => {
    expect(resizePattern([3, 1], 5)).toEqual([3, 1, 2, 2, 2]);
    expect(resizePattern([3, 1, 2], 1)).toEqual([3]);
    expect(resizePattern(resizePattern([3, 1, 2], 1), 4)).toEqual([3, 2, 2, 2]);
  });

  it('rejects garbage, wrong lengths, and invalid levels', () => {
    const fallback = [3, 2, 2, 2];
    expect(sanitizePattern('3111', 4)).toEqual(fallback);
    expect(sanitizePattern([3, 2], 4)).toEqual(fallback);
    expect(sanitizePattern([3, 2, 9, 2], 4)).toEqual(fallback);
    expect(sanitizePattern([3, 2, 0, 2], 4)).toEqual([3, 2, 0, 2]);
  });

  it('maps the legacy soft level to normal', () => {
    expect(sanitizePattern([3, 1, 0, 1], 4)).toEqual([3, 2, 0, 2]);
  });
});
