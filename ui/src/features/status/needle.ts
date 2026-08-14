/** Needle-scale maths, kept pure so the readout stays a thin shell.
 *
 * The needle covers ±50 cents, but the cents that matter are the last few:
 * once a string is within ±5c the player is reading a tenth of a linear scale
 * while the outer forty cents sit idle. The magnified scales spend the width
 * where the tuning happens instead, by warping cents through
 *
 *     offset(c) = 50 · asinh(c / b) / asinh(50 / b)
 *
 * asinh is linear near zero and logarithmic far from it, so the centre is a
 * plain (steeper) needle rather than a singularity — a power or circle curve
 * would have infinite slope at zero and turn each fraction-of-a-cent of DSP
 * scatter into a visible lurch. The break point b sets where linear gives way
 * to log, and is chosen per precision so the slope at zero — the visual
 * magnification — comes out at the advertised ×2 / ×4. Zero and ±50 map to
 * themselves at every precision: dead centre is still dead centre and the
 * needle still pegs at the same edges.
 */

import type { NeedlePrecision } from '../../lib/engine/types';

/** Full deflection: the needle pegs at ±50 cents, half a semitone either way. */
export const NEEDLE_RANGE_CENTS = 50;

/** The cents the scale's quarter ticks mark. Fixed in cents, not in width —
    on magnified scales the ticks slide outward with the warp so they keep
    marking ±25c rather than dressing the same pixels. */
export const NEEDLE_TICK_CENTS = 25;

/** asinh break point per magnification, solved so the slope at zero,
    50 / (b · asinh(50 / b)), lands on the precision it advertises. */
const SCALE_BREAK: Record<Exclude<NeedlePrecision, 1>, number> = { 2: 12, 4: 3.75 };

/** Needle deflection for a reading, as a signed percentage of half the scale:
    0 is centred, ±50 is pegged. At ×1 this is the cents themselves. */
export function needleOffset(cents: number, precision: NeedlePrecision): number {
  const clamped = Math.max(-NEEDLE_RANGE_CENTS, Math.min(NEEDLE_RANGE_CENTS, cents));
  if (precision === 1) return clamped;
  const breakPoint = SCALE_BREAK[precision];
  return (
    (Math.sign(clamped) * NEEDLE_RANGE_CENTS * Math.asinh(Math.abs(clamped) / breakPoint)) /
    Math.asinh(NEEDLE_RANGE_CENTS / breakPoint)
  );
}

/** Where the ±25c quarter ticks sit, as percentages across the scale's width
    (left tick, right tick). 25%/75% on the linear scale, further out when the
    centre is magnified. */
export function needleTickPercents(precision: NeedlePrecision): { lo: number; hi: number } {
  const offset = needleOffset(NEEDLE_TICK_CENTS, precision);
  return { lo: 50 - offset, hi: 50 + offset };
}
