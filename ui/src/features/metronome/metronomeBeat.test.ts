import { describe, expect, it } from 'vitest';
import { extrapolateBeat, type MetronomeSnapshot } from './metronomeBeat';

const snap = (patch: Partial<MetronomeSnapshot> = {}): MetronomeSnapshot => ({
  running: true,
  bpm: 120,
  beatsPerBar: 4,
  beat: 0,
  beatPhase: 0,
  receivedAtMs: 1000,
  ...patch,
});

describe('extrapolateBeat', () => {
  it('crosses a beat boundary and wraps the bar', () => {
    const crossed = extrapolateBeat(snap({ beat: 1, beatPhase: 0.8 }), 1200);
    expect(crossed.beat).toBe(2);
    expect(crossed.phase).toBeCloseTo(0.2);
    const wrapped = extrapolateBeat(snap({ beat: 3, beatPhase: 0.8 }), 1200);
    expect(wrapped.beat).toBe(0);
    expect(wrapped.phase).toBeCloseTo(0.2);
  });

  it('survives a multi-beat status gap', () => {
    const result = extrapolateBeat(snap(), 3750);
    expect(result.beat).toBe(1);
    expect(result.phase).toBeCloseTo(0.5);
  });

  it('freezes while stopped and never runs backward on clock skew', () => {
    expect(extrapolateBeat(snap({ running: false, beat: 2, beatPhase: 0.4 }), 5000)).toEqual({
      beat: 2,
      phase: 0.4,
    });
    expect(extrapolateBeat(snap({ beat: 2, beatPhase: 0.4 }), 500)).toEqual({
      beat: 2,
      phase: 0.4,
    });
  });

  it('guards degenerate tempo and bar values', () => {
    expect(extrapolateBeat(snap({ bpm: 0, beat: 1 }), 5000).beat).toBe(1);
    expect(extrapolateBeat(snap({ beatsPerBar: 0, beat: 1 }), 5000).beat).toBe(1);
  });
});
