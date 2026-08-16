import { describe, expect, it } from 'vitest';
import { extrapolatePosition, formatLoopSeconds, MAX_LOOP_SECONDS } from './looperPosition';
import type { LooperSnapshot } from './looperPosition';

const snap = (over: Partial<LooperSnapshot>): LooperSnapshot => ({
  state: 'playing',
  position: 0,
  lengthSeconds: 4,
  receivedAtMs: 1000,
  ...over,
});

describe('extrapolatePosition', () => {
  it('advances a playing loop by the elapsed fraction', () => {
    expect(extrapolatePosition(snap({ position: 0.25 }), 2000)).toBeCloseTo(0.5);
  });

  it('wraps playback at 1', () => {
    expect(extrapolatePosition(snap({ position: 0.9 }), 2000)).toBeCloseTo(0.15);
  });

  it('advances an overdub the same way', () => {
    expect(extrapolatePosition(snap({ state: 'overdubbing', position: 0.5 }), 2000)).toBeCloseTo(
      0.75,
    );
  });

  it('fills a recording toward the buffer limit and clamps at 1', () => {
    const recording = snap({ state: 'recording', position: 0.5, lengthSeconds: 30 });
    expect(extrapolatePosition(recording, 1000 + MAX_LOOP_SECONDS * 250)).toBeCloseTo(0.5 + 0.25);
    expect(extrapolatePosition(recording, 1000 + MAX_LOOP_SECONDS * 10_000)).toBe(1);
  });

  it('freezes stopped and empty states where the engine reported them', () => {
    expect(extrapolatePosition(snap({ state: 'stopped', position: 0.4 }), 99_000)).toBe(0.4);
    expect(extrapolatePosition(snap({ state: 'empty', position: 0 }), 99_000)).toBe(0);
  });

  it('never runs backwards on a clock skew', () => {
    expect(extrapolatePosition(snap({ position: 0.25 }), 500)).toBeCloseTo(0.25);
  });

  it('holds position on a zero-length loop instead of dividing by zero', () => {
    expect(extrapolatePosition(snap({ lengthSeconds: 0, position: 0.3 }), 2000)).toBe(0.3);
  });
});

describe('formatLoopSeconds', () => {
  it('formats sub-minute lengths with a leading zero', () => {
    expect(formatLoopSeconds(7.31)).toBe('0:07.3');
  });

  it('carries whole minutes', () => {
    expect(formatLoopSeconds(75.06)).toBe('1:15.1');
  });

  it('clamps negatives to zero', () => {
    expect(formatLoopSeconds(-3)).toBe('0:00.0');
  });
});
