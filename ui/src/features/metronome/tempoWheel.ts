/** Shift matches the fine modifier used by rack knobs. */
export const FINE_RATE = 0.25;
export const PIXELS_PER_BPM = 2;

/** Per-pointer-move BPM delta: up and right increase, down and left decrease. */
export function wheelDelta(dxPx: number, dyPx: number, shiftHeld: boolean): number {
  const rate = shiftHeld ? FINE_RATE : 1;
  return ((dxPx - dyPx) / PIXELS_PER_BPM) * rate;
}
