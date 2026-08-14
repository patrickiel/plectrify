/** Strobe-tuner maths, kept pure so the animation loop stays a thin shell.
 *
 * A mechanical strobe disc with N wedges, lit by a lamp flashing at the incoming
 * pitch f_in and spun so that f_ref = N·Ω, drifts at (f_in − f_ref)/N rev/s.
 * Measured in *one pattern period* rather than one revolution, that is simply
 * the beat frequency f_in − f_ref. So the display's drift rate is the pitch
 * error, and integrating that rate in requestAnimationFrame is not a simulation
 * of a strobe — it is the same integral the optics perform.
 *
 * Absolute phase carries no information (a real strobe freezes at whatever angle
 * it happens to be at), which is why nothing here needs phase from the engine.
 */

/** How much finer the second row is than the first. Four rather than two: at ×4
    apart the top row still crawls while the bottom row is moving briskly, so one
    row is for getting close and the other for the last fraction of a cent. At ×2
    they read too much alike to be worth two rows. */
export const STROBE_ROW_RATIO = 4;

/** The two harmonics the display watches, from the user's precision setting.
    Watching harmonics rather than the fundamental is the point: guitar and bass
    strings are low, and the fundamental of a five-string bass B resolves only 8.4
    cents — worse than the needle it replaces. The default ×2/×8 reaches 4.2 and
    1.05 cents on that same low B, and 1.6/0.39 on a low E, while both rows hold
    across every open string on both instruments.

    Push the setting higher and the fine row starts showing filter noise instead
    of the string on the upper strings; `bandIsUsable` idles it there rather than
    letting it drift convincingly at nothing. */
export function strobeMultipliers(precision: number): number[] {
  return [precision, precision * STROBE_ROW_RATIO];
}

/** The default pair, ×2 and ×8. */
export const STROBE_MULTIPLIERS = strobeMultipliers(2);

/** Beat frequency per cent of error, per Hz of reference — i.e. d(beat)/d(cents)
    at zero error, = ln2/1200. Used for the resolution and usability arithmetic,
    where a linear approximation over a few cents is exact enough. `beatHz`
    itself uses the true exponential. */
const BEAT_HZ_PER_CENT_PER_HZ = Math.LN2 / 1200; // 5.7762265e-4

/** Slowest drift a person reliably notices as movement: one pattern period per
    ~7 seconds. This is what sets each lane's usable resolution. */
const VISIBLE_TURNS_PER_SECOND = 0.15;

/** Frame-to-frame scatter left in the cents reading *after* the filter below, in
    cents. The detector's own contract is ≤1.0 cent (Tests/audio/TunerDetectorTests.cpp),
    but that is an accuracy bound on an already median-of-3 smoothed value; what
    makes a lane wobble is the residual jitter, and a 300 ms filter over a 15 Hz
    feed cuts that to roughly a third. Using the raw 1.0 here would be measuring
    the wrong quantity, and would idle the high strings for no reason. */
const FILTERED_JITTER_CENTS = 0.35;

/** How much noise-driven drift a lane may show before it reads as broken rather
    than as detuned. Bounds which multipliers are offered at a given pitch. */
const NOISE_CEILING_TURNS_PER_SECOND = 1.2;

/** The drift rate that is nicest to read: fast enough to be unmistakable,
    slow enough to follow individual periods. Picks the promoted lane. */
const READABLE_TURNS_PER_SECOND = 1.2;

/** Above this the pattern aliases at 60 fps — fewer than ~6.7 frames per period —
    and can appear to drift *backwards*. Rates beyond it are clamped for display
    and the pattern is smeared instead, so "far off, this way" never turns into a
    confident lie about the direction. */
export const MAX_DISPLAY_TURNS_PER_SECOND = 9;

/** Where smearing starts, and the span over which it reaches full strength. */
const SMEAR_ONSET_TURNS_PER_SECOND = 3;
const SMEAR_RANGE_TURNS_PER_SECOND = 6;

/** Time constant for the cents filter. Much longer than the needle's 85 ms
    (StatusBar.svelte): ±1 cent of detector noise at A4 is ±0.25 turns/s of rate
    jitter, which shimmies instead of gliding, and a tuning peg takes about a
    second to turn — so this costs nothing perceptually and buys a third of the
    noise. */
export const CENTS_TIME_CONSTANT_SECONDS = 0.3;

/** Time constant for the rate filter, applied per animation frame. Its job is
    not noise (the cents filter above did that) but hiding the 15 Hz staircase of
    the engine's status feed. Reads as the disc's rotational inertia. */
const RATE_TIME_CONSTANT_SECONDS = 0.09;

/** Below this, on both the target and the eased value, the rate is snapped to a
    true zero. Without the snap an exponential filter never actually arrives and
    a "frozen" pattern creeps forever — which collapses the entire illusion,
    since stillness is the whole readout. */
const RATE_STOP_TURNS_PER_SECOND = 0.02;

/** Longest frame step honoured, matching the needle loop's own clamp. A GC pause
    or a backgrounded window would otherwise teleport the pattern, which reads as
    a glitch rather than as motion. */
export const MAX_FRAME_SECONDS = 0.05;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Equal-tempered frequency of a MIDI note, A440. */
export function referenceHz(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

/** Beat frequency for a pitch `cents` away from `reference`, in Hz — equivalently
    the drift in pattern periods per second of a band watching the fundamental.
    Positive is sharp.

    Takes cents rather than a measured frequency so it can be fed *filtered*
    cents, for which no measured frequency exists. It agrees exactly with
    `reading.frequencyHz - referenceHz(reading.midiNote)`, because TunerDetector
    builds the published frequency as `reference * 2^(cents/1200)` — see
    `acceptCandidate` in Source/audio/TunerDetector.cpp. strobe.test.ts pins that
    equivalence. */
export function beatHz(cents: number, reference: number): number {
  return reference * (2 ** (cents / 1200) - 1);
}

/** Smallest error, in cents, that `multiplier`'s lane can still show as visible
    creep at this pitch. Lower is finer.

    Nothing renders this — the display shows two unlabelled rows. It stays because
    it is the arithmetic the whole choice of multipliers rests on, and its tests
    are what hold the figures quoted in `strobeMultipliers` above honest. */
export function bandResolutionCents(multiplier: number, reference: number): number {
  return VISIBLE_TURNS_PER_SECOND / (multiplier * reference * BEAT_HZ_PER_CENT_PER_HZ);
}

/** Whether a lane is showing the string rather than the filter's residual noise.
    False once the multiplier's share of that jitter would drift faster than the
    ceiling — i.e. multiplier > ~5900/reference, so ×4 holds across the detector's
    whole range, ×16 to about F5, and ×32 only up to about F3. */
export function bandIsUsable(multiplier: number, reference: number): boolean {
  const noiseTurnsPerSecond =
    multiplier * FILTERED_JITTER_CENTS * reference * BEAT_HZ_PER_CENT_PER_HZ;
  return noiseTurnsPerSecond < NOISE_CEILING_TURNS_PER_SECOND;
}

/** One lane of the expanded display. */
export interface StrobeBand {
  /** Harmonic of the fundamental this lane watches. */
  multiplier: number;
  /** Drift in pattern periods per second. Signed: positive is sharp. */
  turnsPerSecond: number;
  /** False when the detector's own noise would dominate — the lane holds still
      instead of animating, rather than lying at speed. */
  usable: boolean;
  /** The one lane currently worth looking at; promoted visually. */
  primary: boolean;
}

/** Per-lane drift rates for an error of `cents` at a pitch of `reference` Hz,
    ordered by ascending multiplier.

    Exactly one band is marked `primary`: the usable lane whose rate sits nearest
    the readable sweet spot, on a log scale so being twice too fast and twice too
    slow count equally. When nothing is moving there is no rate to judge, so the
    finest usable lane wins — it is the one that will reveal residual error
    soonest. This is the expertise a hardware-strobe player supplies by choosing
    a band manually. */
export function strobeBands(
  cents: number,
  reference: number,
  multipliers: readonly number[] = STROBE_MULTIPLIERS,
): StrobeBand[] {
  const fundamentalBeat = beatHz(cents, reference);
  const bands = multipliers.map((multiplier) => ({
    multiplier,
    turnsPerSecond: multiplier * fundamentalBeat,
    usable: bandIsUsable(multiplier, reference),
    primary: false,
  }));

  const usable = bands.filter((band) => band.usable);
  if (usable.length === 0) {
    // Unreachable for the detector's 30–1320 Hz range, where ×1 always holds,
    // but a caller passing exotic multipliers shouldn't get a primary-less list.
    if (bands.length > 0) bands[0].primary = true;
    return bands;
  }

  const moving = usable.filter((band) => Math.abs(band.turnsPerSecond) >= VISIBLE_TURNS_PER_SECOND);
  if (moving.length === 0) {
    usable[usable.length - 1].primary = true;
    return bands;
  }

  const distance = (band: StrobeBand) =>
    Math.abs(Math.log(Math.abs(band.turnsPerSecond) / READABLE_TURNS_PER_SECOND));
  moving.reduce((best, band) => (distance(band) < distance(best) ? band : best)).primary = true;
  return bands;
}

/** Hold the display rate inside what 60 fps can represent without aliasing. */
export function clampTurnsPerSecond(
  turnsPerSecond: number,
  max: number = MAX_DISPLAY_TURNS_PER_SECOND,
): number {
  return Math.max(-max, Math.min(max, turnsPerSecond));
}

/** How blurred the pattern should be, 0 crisp to 1 fully smeared. Stands in for
    a real strobe's optical blur, so a clamped rate reads as "too fast to
    resolve" instead of as structure that isn't there. */
export function smearAmount(turnsPerSecond: number): number {
  return clamp01(
    (Math.abs(turnsPerSecond) - SMEAR_ONSET_TURNS_PER_SECOND) / SMEAR_RANGE_TURNS_PER_SECOND,
  );
}

/** One step of an exponential filter, framed in seconds so the result is
    frame-rate independent — 120 fps and 60 fps converge at the same speed. */
export function easeToward(
  current: number,
  target: number,
  deltaSeconds: number,
  timeConstantSeconds: number,
): number {
  if (timeConstantSeconds <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-deltaSeconds / timeConstantSeconds));
}

/** Drift state for one lane: where the pattern sits, and how fast it is moving. */
export interface StrobePhase {
  /** Position within one pattern period, wrapped to [0, 1). */
  phase: number;
  /** Current eased drift, in pattern periods per second. */
  rate: number;
}

/** Advance one lane by `deltaSeconds`.
 *
 * The *rate* is eased, never the phase. Easing the phase would make a string
 * being sharpened appear to drift backwards for a moment, because the display
 * would still be catching up to where it already was. Easing the rate instead is
 * exactly a disc's rotational inertia, and it is also what makes the 15 Hz
 * status feed look continuous.
 */
export function advanceStrobe(
  state: StrobePhase,
  targetTurnsPerSecond: number,
  deltaSeconds: number,
  rateTimeConstantSeconds: number = RATE_TIME_CONSTANT_SECONDS,
): StrobePhase {
  const step = Math.max(0, Math.min(MAX_FRAME_SECONDS, deltaSeconds));
  let rate = easeToward(state.rate, targetTurnsPerSecond, step, rateTimeConstantSeconds);
  if (
    Math.abs(targetTurnsPerSecond) < RATE_STOP_TURNS_PER_SECOND &&
    Math.abs(rate) < RATE_STOP_TURNS_PER_SECOND
  )
    rate = 0;

  const advanced = state.phase + rate * step;
  return { phase: advanced - Math.floor(advanced), rate };
}
