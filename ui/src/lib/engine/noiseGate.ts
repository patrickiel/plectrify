/**
 * The built-in noise gate's page-side constants and the one rule the mock
 * needs to draw it. The engine (`Source/audio/NoiseGate.h`) owns the DSP;
 * these mirror its control ranges so the slideout's sliders and the engine's
 * clamps agree, and the two files must be kept in step.
 */

export const NOISE_GATE_THRESHOLD_DB = { min: -80, max: -10, default: -50, step: 1 } as const;
export const NOISE_GATE_HOLD_MS = { min: 0, max: 500, default: 50, step: 10 } as const;
export const NOISE_GATE_RELEASE_MS = { min: 10, max: 2000, default: 250, step: 10 } as const;
export const NOISE_GATE_ATTACK_MS = { min: 0.1, max: 50, default: 2, step: 0.1 } as const;
export const NOISE_GATE_RANGE_DB = { min: 10, max: 70, default: 50, step: 1 } as const;

/** How the gain behaves below the close threshold. Soft and firm are expander
    slopes (2 and 4 dB per dB), hard is a classic gate straight to the floor.
    Crosses the bridge as the engine's integer, hence the two tables. */
export type NoiseGateShape = 'soft' | 'firm' | 'hard';
export const NOISE_GATE_SHAPES: readonly NoiseGateShape[] = ['soft', 'firm', 'hard'];
export const NOISE_GATE_DEFAULT_SHAPE: NoiseGateShape = 'firm';
const SHAPE_SLOPE: Record<NoiseGateShape, number> = { soft: 2, firm: 4, hard: Infinity };

export function noiseGateShapeFromEngine(value: unknown): NoiseGateShape {
  return typeof value === 'number' && NOISE_GATE_SHAPES[value] !== undefined
    ? NOISE_GATE_SHAPES[value]
    : NOISE_GATE_DEFAULT_SHAPE;
}

export function noiseGateShapeToEngine(shape: NoiseGateShape): number {
  return Math.max(0, NOISE_GATE_SHAPES.indexOf(shape));
}

/** The close threshold sits this far under the open threshold (hysteresis). */
export const NOISE_GATE_HYSTERESIS_DB = 6;
/** The attenuation a closed gate settles on for a steady level — the engine's
    static curve, with no hold or release in it. 0 at or above the close
    threshold; below it the shape's slope per dB (hard: the whole range at
    once), floored at the range. Used by the mock's meters. */
export function noiseGateSteadyReductionDb(
  levelDb: number,
  thresholdDb: number,
  shape: NoiseGateShape = NOISE_GATE_DEFAULT_SHAPE,
  rangeDb: number = NOISE_GATE_RANGE_DB.default,
): number {
  const closeThresholdDb = thresholdDb - NOISE_GATE_HYSTERESIS_DB;
  if (levelDb >= closeThresholdDb) return 0;
  const slope = SHAPE_SLOPE[shape];
  if (!Number.isFinite(slope)) return -rangeDb;
  return Math.max(-rangeDb, slope * (levelDb - closeThresholdDb));
}

export function formatGateReduction(reductionDb: number): string {
  return `−${Math.abs(Math.round(reductionDb))} dB`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
