import { MAX_BPM, MIN_BPM } from './metronomeBeat';

export const TAP_TIMEOUT_MS = 2000;
export const MAX_TAPS = 5;

export interface TapResult {
  taps: number[];
  bpm: number | null;
}

export function registerTap(taps: readonly number[], nowMs: number): TapResult {
  const last = taps.at(-1);
  const history =
    last === undefined || nowMs < last || nowMs - last > TAP_TIMEOUT_MS ? [] : [...taps];
  history.push(nowMs);
  const kept = history.slice(-MAX_TAPS);
  if (kept.length < 2) return { taps: kept, bpm: null };

  const elapsed = kept.at(-1)! - kept[0];
  if (elapsed <= 0) return { taps: kept, bpm: null };
  const measured = Math.round((60000 * (kept.length - 1)) / elapsed);
  return { taps: kept, bpm: Math.max(MIN_BPM, Math.min(MAX_BPM, measured)) };
}
