import { describe, expect, it } from 'vitest';
import {
  NOISE_GATE_HYSTERESIS_DB,
  NOISE_GATE_RANGE_DB,
  formatGateReduction,
  formatMs,
  noiseGateShapeFromEngine,
  noiseGateShapeToEngine,
  noiseGateSteadyReductionDb,
} from './noiseGate';

describe('noiseGateSteadyReductionDb', () => {
  it('leaves a level at or above the close threshold alone', () => {
    expect(noiseGateSteadyReductionDb(-20, -50)).toBe(0);
    expect(noiseGateSteadyReductionDb(-50, -50)).toBe(0);
    expect(noiseGateSteadyReductionDb(-50 - NOISE_GATE_HYSTERESIS_DB, -50)).toBe(0);
  });

  it("attenuates along the shape's slope below the close threshold", () => {
    const closeThreshold = -50 - NOISE_GATE_HYSTERESIS_DB;
    expect(noiseGateSteadyReductionDb(closeThreshold - 1, -50, 'soft', 70)).toBe(-2);
    expect(noiseGateSteadyReductionDb(closeThreshold - 9, -50, 'firm', 70)).toBe(-36);
    expect(noiseGateSteadyReductionDb(closeThreshold - 1, -50, 'hard', 70)).toBe(-70);
  });

  it('floors at the range whatever the shape', () => {
    expect(noiseGateSteadyReductionDb(-120, -10, 'soft', 40)).toBe(-40);
    expect(noiseGateSteadyReductionDb(-120, -10, 'hard', 10)).toBe(-10);
    expect(noiseGateSteadyReductionDb(-120, -10)).toBe(-NOISE_GATE_RANGE_DB.default);
  });
});

describe('shape codec', () => {
  it('round-trips through the engine integer and defaults the unknown', () => {
    expect(noiseGateShapeToEngine('soft')).toBe(0);
    expect(noiseGateShapeToEngine('hard')).toBe(2);
    expect(noiseGateShapeFromEngine(1)).toBe('firm');
    expect(noiseGateShapeFromEngine(9)).toBe('firm');
    expect(noiseGateShapeFromEngine('hard')).toBe('firm');
  });
});

describe('formatting', () => {
  it('prints reductions as a negative whole dB', () => {
    expect(formatGateReduction(-23.6)).toBe('−24 dB');
    expect(formatGateReduction(0)).toBe('−0 dB');
  });

  it('prints milliseconds and seconds', () => {
    expect(formatMs(50)).toBe('50 ms');
    expect(formatMs(1000)).toBe('1.0 s');
  });
});
