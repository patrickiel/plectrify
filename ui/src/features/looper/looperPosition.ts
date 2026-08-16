import type { LooperState } from '../../lib/engine/types';

/** The engine's buffer limit; recording auto-closes into playback here. Keep
    in step with LooperProcessor::maxLoopSeconds. */
export const MAX_LOOP_SECONDS = 60;

/** One 15 Hz status push, stamped with when it arrived so the ring can move
    smoothly between pushes instead of stepping. */
export interface LooperSnapshot {
  state: LooperState;
  /** Playhead 0..1; while recording, the fill fraction of MAX_LOOP_SECONDS. */
  position: number;
  lengthSeconds: number;
  receivedAtMs: number;
}

/** Where the playhead is `nowMs`, extrapolated from the last push. Playback
    wraps at 1; a recording fills toward 1 and stops there (the engine will
    have auto-closed by then); every other state is frozen where the engine
    reported it. */
export function extrapolatePosition(snap: LooperSnapshot, nowMs: number): number {
  const elapsedSeconds = Math.max(0, nowMs - snap.receivedAtMs) / 1000;
  if (snap.state === 'recording') {
    return Math.min(1, snap.position + elapsedSeconds / MAX_LOOP_SECONDS);
  }
  if ((snap.state === 'playing' || snap.state === 'overdubbing') && snap.lengthSeconds > 0) {
    return (snap.position + elapsedSeconds / snap.lengthSeconds) % 1;
  }
  return snap.position;
}

/** "0:07.3" style readout for the loop length / elapsed record time. */
export function formatLoopSeconds(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
