/** One engine status push, timestamped when the UI receives it. */
export interface MetronomeSnapshot {
  running: boolean;
  bpm: number;
  beatsPerBar: number;
  beat: number;
  beatPhase: number;
  receivedAtMs: number;
}

export interface DisplayBeat {
  beat: number;
  phase: number;
}

/** Keep in step with MetronomeProcessor. */
export const MIN_BPM = 40;
export const MAX_BPM = 240;

/** Advance a 15 Hz engine snapshot on the browser's animation clock. */
export function extrapolateBeat(snapshot: MetronomeSnapshot, nowMs: number): DisplayBeat {
  const beats = Math.floor(snapshot.beatsPerBar);
  const frozen = {
    beat: Number.isFinite(snapshot.beat) ? Math.max(0, Math.floor(snapshot.beat)) : 0,
    phase: Number.isFinite(snapshot.beatPhase) ? Math.max(0, Math.min(1, snapshot.beatPhase)) : 0,
  };
  if (!snapshot.running || !Number.isFinite(snapshot.bpm) || snapshot.bpm <= 0 || beats <= 0)
    return frozen;

  const elapsedBeats = ((Math.max(0, nowMs - snapshot.receivedAtMs) / 1000) * snapshot.bpm) / 60;
  if (elapsedBeats === 0) return frozen; // clock skew: hold exactly, don't round through floats
  const total = frozen.beat + frozen.phase + elapsedBeats;
  const whole = Math.floor(total);
  return { beat: ((whole % beats) + beats) % beats, phase: total - whole };
}
