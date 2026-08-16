import { bufferMilliseconds } from '../../lib/engine/audioDevices';

/**
 * Latency in the words a guitarist judges it by.
 *
 * A block size is not a setting anyone has an opinion about; the delay between
 * the pick and the speaker is. So the wizard's latency step names the number of
 * samples only in passing and leads with the milliseconds, and with what those
 * milliseconds feel like — which is the only reason the step exists at all.
 */

/** Round-trip latency in milliseconds: what the driver reports in and out of
    the interface, plus whatever the loaded plugins add. Zero for a device that
    has not reported a rate, and for a chain with nothing in it. */
export function latencyMilliseconds(totalSamples: number, sampleRate: number): number {
  if (totalSamples < 0 || sampleRate <= 0) return 0;
  return (1000 * totalSamples) / sampleRate;
}

export type LatencyVerdict = 'imperceptible' | 'comfortable' | 'noticeable';

/**
 * Where a round trip sits for someone holding a pick.
 *
 * The boundaries are the two thresholds that matter to playing rather than to
 * measuring. Under 7 ms is inside the delay a player already lives with
 * standing a couple of metres from their own cabinet, so it does not register
 * as delay at all. Under 15 ms is the range every plugin host is normally used
 * at — audible if you go looking, invisible while playing. Past that a fast
 * strumming hand starts to feel it, which is not wrong for practice but is
 * worth saying out loud rather than leaving to be discovered on stage.
 */
export function latencyVerdict(ms: number): LatencyVerdict {
  if (ms < 7) return 'imperceptible';
  if (ms < 15) return 'comfortable';
  return 'noticeable';
}

const VERDICT_TEXT: Record<LatencyVerdict, string> = {
  imperceptible: "You won't feel this.",
  comfortable: 'Fine for playing. Go lower if it stays clean.',
  noticeable: 'Playable, but you may feel it. Try smaller.',
};

export function describeLatency(ms: number): string {
  return VERDICT_TEXT[latencyVerdict(ms)];
}

/** One buffer-size choice as the step offers it: "128 samples · 2.7 ms". The
    milliseconds lead the reasoning even though the samples lead the label —
    the number the driver wants is the one being set, and the number the player
    cares about is the one being explained. */
export function describeBufferSize(size: number, sampleRate: number): string {
  const ms = bufferMilliseconds(size, sampleRate);
  return ms > 0 ? `${size} samples · ${formatMs(ms)} ms` : `${size} samples`;
}

/** Milliseconds at the precision they are worth reading at: one decimal under
    ten, none above. 2.7 and 21 are both honest; 21.3 is noise. */
export function formatMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : Math.round(ms).toString();
}
