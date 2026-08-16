import { describe, expect, it } from 'vitest';
import {
  advanceStrobe,
  beatHz,
  bandIsUsable,
  bandResolutionCents,
  clampTurnsPerSecond,
  easeToward,
  MAX_DISPLAY_TURNS_PER_SECOND,
  referenceHz,
  smearAmount,
  STROBE_ROW_RATIO,
  strobeBands,
  strobeMultipliers,
  type StrobePhase,
} from './strobe';

/** The notes the native tuner tests use, so both suites talk about the same
    pitches: 5-string bass low B, low E, open A, concert A, top of range. */
const B0 = 30.868;
const E2 = 82.407;
const A4 = 440;
const E6 = 1318.51;

/** How TunerDetector::acceptCandidate builds the frequency it publishes. */
const publishedFrequency = (midiNote: number, cents: number) =>
  referenceHz(midiNote) * 2 ** (cents / 1200);

/** Distance to the nearest whole turn. Phase is circular, so 0.999… and 0.001
    are both "back where it started" and a plain difference would miss that. */
const turnsFromStart = (phase: number) => Math.min(phase, 1 - phase);

const bandFor = (bands: ReturnType<typeof strobeBands>, multiplier: number) => {
  const band = bands.find((candidate) => candidate.multiplier === multiplier);
  if (band === undefined) throw new Error(`no ×${multiplier} band`);
  return band;
};

describe('referenceHz', () => {
  it('anchors on A440 and matches the notes the native tests use', () => {
    expect(referenceHz(69)).toBe(440);
    expect(referenceHz(57)).toBeCloseTo(220, 10);
    expect(referenceHz(23)).toBeCloseTo(B0, 3);
    expect(referenceHz(40)).toBeCloseTo(E2, 3);
    expect(referenceHz(88)).toBeCloseTo(E6, 2);
  });
});

describe('beatHz', () => {
  it('is signed, symmetric in ratio, and exactly zero in tune', () => {
    expect(beatHz(1, A4)).toBeCloseTo(0.2542, 4);
    expect(beatHz(-1, A4)).toBeCloseTo(-0.2541, 4);
    expect(beatHz(0, A4)).toBe(0);
    expect(beatHz(10, A4)).toBeGreaterThan(beatHz(1, A4));
  });

  it('scales with the reference, so the same error beats faster up high', () => {
    expect(beatHz(1, E2)).toBeCloseTo(0.0476, 4);
    expect(beatHz(1, B0)).toBeCloseTo(0.0178, 4);
    expect(beatHz(1, E6)).toBeCloseTo(0.7618, 4);
  });

  // The whole reason beatHz takes cents rather than a measured frequency: it has
  // to accept *filtered* cents, for which no measured frequency exists. This
  // pins that doing so stays consistent with what the engine actually sends.
  it('agrees with frequencyHz − referenceHz, the form the engine publishes', () => {
    for (const midiNote of [23, 40, 69, 88]) {
      for (const cents of [-40, -3.5, -0.25, 0, 0.25, 3.5, 40]) {
        const reference = referenceHz(midiNote);
        const fromFrequency = publishedFrequency(midiNote, cents) - reference;
        expect(beatHz(cents, reference)).toBeCloseTo(fromFrequency, 12);
      }
    }
  });
});

describe('bandResolutionCents', () => {
  // The fundamental resolves only 8.4 cents on a low B — worse than the needle it
  // replaces. That gap is the whole reason the ladder sits as high as ×8/×16.
  it('matches the published resolution table', () => {
    expect(bandResolutionCents(1, B0)).toBeCloseTo(8.41, 2);
    expect(bandResolutionCents(8, B0)).toBeCloseTo(1.05, 2);
    expect(bandResolutionCents(16, B0)).toBeCloseTo(0.53, 2);
    expect(bandResolutionCents(8, E2)).toBeCloseTo(0.39, 2);
    expect(bandResolutionCents(16, E2)).toBeCloseTo(0.2, 2);
    expect(bandResolutionCents(8, A4)).toBeCloseTo(0.07, 2);
  });

  it('gets finer with the multiplier, and coarser as the pitch drops', () => {
    expect(bandResolutionCents(16, A4)).toBeLessThan(bandResolutionCents(8, A4));
    expect(bandResolutionCents(8, A4)).toBeLessThan(bandResolutionCents(1, A4));
    expect(bandResolutionCents(8, B0)).toBeGreaterThan(bandResolutionCents(8, E6));
  });
});

describe('bandIsUsable', () => {
  // Pinned exactly, so the ceiling can't drift silently: a looser rule would
  // quietly start animating lanes that are only showing detector noise.
  it('pins where each multiplier stops showing the string', () => {
    // Low multipliers hold across the detector's whole 30–1320 Hz range.
    expect(bandIsUsable(2, B0)).toBe(true);
    expect(bandIsUsable(2, E6)).toBe(true);
    // ×8 holds to about F6, so it covers the guitar but not the very top.
    expect(bandIsUsable(8, A4)).toBe(true);
    expect(bandIsUsable(8, E6)).toBe(false);
    // ×16, the finest precision's fine row, holds to about F5 — past the high
    // E string, short of concert A.
    expect(bandIsUsable(16, referenceHz(64))).toBe(true);
    expect(bandIsUsable(16, A4)).toBe(false);
    // Beyond the offered ladder the rule still bounds exotic multipliers.
    expect(bandIsUsable(32, E2)).toBe(true);
    expect(bandIsUsable(32, A4)).toBe(false);
  });

  // The point of basing the rule on post-filter jitter rather than the detector's
  // raw accuracy bound: at ×16 the raw figure would idle everything above a low
  // D, taking the strobe away from four of a guitar's six strings.
  it('keeps the two lowest precisions usable across every open string', () => {
    // B0 E1 A1 D2 G2 — five-string bass; E2 A2 D3 G3 B3 E4 — guitar.
    for (const midiNote of [23, 28, 33, 38, 43, 40, 45, 50, 55, 59, 64]) {
      for (const precision of [1, 2]) {
        for (const multiplier of strobeMultipliers(precision)) {
          expect(bandIsUsable(multiplier, referenceHz(midiNote))).toBe(true);
        }
      }
    }
  });

  it('keeps the fundamental usable across the detector 30–1320 Hz range', () => {
    for (const reference of [B0, E2, A4, E6]) expect(bandIsUsable(1, reference)).toBe(true);
  });
});

describe('strobeMultipliers', () => {
  it('pairs the chosen precision with a row four times finer', () => {
    expect(strobeMultipliers(1)).toEqual([1, 4]);
    expect(strobeMultipliers(2)).toEqual([2, 8]);
    expect(strobeMultipliers(4)).toEqual([4, 16]);
  });

  it('always returns two rows, coarse first', () => {
    for (const precision of [1, 2, 4]) {
      const [coarse, fine] = strobeMultipliers(precision);
      expect(fine).toBe(coarse * STROBE_ROW_RATIO);
      expect(fine).toBeGreaterThan(coarse);
    }
  });
});

describe('strobeBands', () => {
  it('reports the lanes in order at an exact 1:4 rate ratio', () => {
    const bands = strobeBands(3, E2);
    expect(bands.map((band) => band.multiplier)).toEqual([2, 8]);
    expect(bandFor(bands, 8).turnsPerSecond / bandFor(bands, 2).turnsPerSecond).toBeCloseTo(4, 12);
  });

  it('keeps the sign, so sharp and flat never swap lanes', () => {
    for (const band of strobeBands(5, A4)) expect(band.turnsPerSecond).toBeGreaterThan(0);
    for (const band of strobeBands(-5, A4)) expect(band.turnsPerSecond).toBeLessThan(0);
    for (const band of strobeBands(0, A4)) expect(band.turnsPerSecond).toBe(0);
  });

  it('marks exactly one primary lane, and a usable one whenever any lane is', () => {
    for (const cents of [-30, -2, -0.2, 0, 0.2, 2, 30]) {
      for (const reference of [B0, E2, A4, E6]) {
        const bands = strobeBands(cents, reference);
        const primaries = bands.filter((band) => band.primary);
        expect(primaries).toHaveLength(1);
        if (bands.some((band) => band.usable)) expect(primaries[0].usable).toBe(true);
      }
    }
  });

  it('promotes the lane nearest the readable drift rate', () => {
    // A low E two cents sharp crawls at 0.19 turns/s on ×2 but moves at 0.76 on
    // ×8, which is the pair's whole reason for a 1:4 spread.
    expect(bandFor(strobeBands(2, E2), 8).primary).toBe(true);
    // Four octaves up the same error beats eight times faster, so the fine row
    // would be a blur and the coarse one lands nearest the sweet spot.
    expect(bandFor(strobeBands(2, A4), 2).primary).toBe(true);
    // Well out of tune on a low string, the coarse row is already fast enough.
    expect(bandFor(strobeBands(60, E2), 2).primary).toBe(true);
  });

  it('falls back to the finest usable lane when nothing is moving', () => {
    expect(bandFor(strobeBands(0, B0), 8).primary).toBe(true);
    expect(bandFor(strobeBands(0, E2), 8).primary).toBe(true);
    // At a higher precision the fine row has dropped out by concert A, so the
    // coarse one is the finest left.
    const fine = strobeMultipliers(4);
    expect(bandFor(strobeBands(0, A4, fine), 4).primary).toBe(true);
    expect(bandFor(strobeBands(0, A4, fine), 16).usable).toBe(false);
  });

  it('never leaves the list without a primary, even for exotic multipliers', () => {
    const bands = strobeBands(1, E6, [16, 32]);
    expect(bands.every((band) => !band.usable)).toBe(true);
    expect(bands.filter((band) => band.primary)).toHaveLength(1);
  });
});

describe('clampTurnsPerSecond', () => {
  it('bounds the rate without changing its sign', () => {
    expect(clampTurnsPerSecond(2)).toBe(2);
    expect(clampTurnsPerSecond(40)).toBe(MAX_DISPLAY_TURNS_PER_SECOND);
    expect(clampTurnsPerSecond(-40)).toBe(-MAX_DISPLAY_TURNS_PER_SECOND);
  });

  // A top-string note 50 cents sharp beats at 38.6 turns/s, which at 60 fps
  // aliases and would confidently drift the wrong way. Clamping is correctness.
  it('catches the rate that would alias backwards at 60 fps', () => {
    const aliasing = beatHz(50, E6);
    expect(aliasing).toBeGreaterThan(30);
    expect(clampTurnsPerSecond(aliasing)).toBe(MAX_DISPLAY_TURNS_PER_SECOND);
  });
});

describe('smearAmount', () => {
  it('ramps from crisp to fully blurred and ignores direction', () => {
    expect(smearAmount(0)).toBe(0);
    expect(smearAmount(3)).toBe(0);
    expect(smearAmount(6)).toBeCloseTo(0.5, 6);
    expect(smearAmount(9)).toBe(1);
    expect(smearAmount(50)).toBe(1);
    expect(smearAmount(-9)).toBe(1);
  });

  it('never decreases as the rate rises', () => {
    let previous = -1;
    for (let rate = 0; rate <= 12; rate += 0.5) {
      const smear = smearAmount(rate);
      expect(smear).toBeGreaterThanOrEqual(previous);
      previous = smear;
    }
  });
});

describe('easeToward', () => {
  it('converges at the same speed regardless of step size', () => {
    let coarse = 0;
    let fine = 0;
    for (let i = 0; i < 60; i += 1) coarse = easeToward(coarse, 1, 1 / 60, 0.2);
    for (let i = 0; i < 240; i += 1) fine = easeToward(fine, 1, 1 / 240, 0.2);
    expect(fine).toBeCloseTo(coarse, 3);
  });

  it('reaches ~63% of a step in one time constant', () => {
    expect(easeToward(0, 1, 0.2, 0.2)).toBeCloseTo(1 - Math.exp(-1), 12);
  });
});

describe('advanceStrobe', () => {
  const still: StrobePhase = { phase: 0.42, rate: 0 };

  // The freeze *is* the readout. If the phase can creep while in tune, the whole
  // display is a lie, so this is the load-bearing assertion of the feature.
  it('holds absolutely still when in tune', () => {
    let state = still;
    for (let i = 0; i < 600; i += 1) state = advanceStrobe(state, 0, 1 / 60);
    expect(state.phase).toBe(0.42);
    expect(state.rate).toBe(0);
  });

  it('snaps a settling rate to a true stop rather than creeping forever', () => {
    let state: StrobePhase = { phase: 0, rate: 3 };
    for (let i = 0; i < 600; i += 1) state = advanceStrobe(state, 0, 1 / 60);
    expect(state.rate).toBe(0);
    const settled = state.phase;
    for (let i = 0; i < 600; i += 1) state = advanceStrobe(state, 0, 1 / 60);
    expect(state.phase).toBe(settled);
  });

  it('integrates an established rate exactly', () => {
    let state: StrobePhase = { phase: 0, rate: 2 };
    for (let i = 0; i < 60; i += 1) state = advanceStrobe(state, 2, 1 / 60);
    // Two whole turns in one second, so the pattern lands back where it started.
    expect(turnsFromStart(state.phase)).toBeCloseTo(0, 9);
    expect(state.rate).toBeCloseTo(2, 12);
  });

  it('advances the same distance at 60 and 120 fps', () => {
    let slow: StrobePhase = { phase: 0, rate: 1.5 };
    let fast: StrobePhase = { phase: 0, rate: 1.5 };
    for (let i = 0; i < 60; i += 1) slow = advanceStrobe(slow, 1.5, 1 / 60);
    for (let i = 0; i < 120; i += 1) fast = advanceStrobe(fast, 1.5, 1 / 120);
    expect(turnsFromStart(Math.abs(fast.phase - slow.phase))).toBeCloseTo(0, 9);
  });

  it('keeps the phase inside [0, 1) drifting either way', () => {
    let sharp: StrobePhase = { phase: 0, rate: 7 };
    let flat: StrobePhase = { phase: 0, rate: -7 };
    for (let i = 0; i < 500; i += 1) {
      sharp = advanceStrobe(sharp, 7, 1 / 60);
      flat = advanceStrobe(flat, -7, 1 / 60);
      expect(sharp.phase).toBeGreaterThanOrEqual(0);
      expect(sharp.phase).toBeLessThan(1);
      expect(flat.phase).toBeGreaterThanOrEqual(0);
      expect(flat.phase).toBeLessThan(1);
    }
  });

  // Easing the phase instead of the rate would drag the pattern backwards for a
  // moment as the rate rises, which is the one artefact that would make the
  // direction read wrong.
  it('only ever moves forwards while the rate is positive', () => {
    let state: StrobePhase = { phase: 0, rate: 0 };
    for (let i = 0; i < 120; i += 1) {
      const previous = state;
      state = advanceStrobe(state, 4, 1 / 60);
      const moved = state.phase - previous.phase;
      expect(moved >= 0 || moved < -0.5).toBe(true); // forwards, or wrapped past 1
      expect(state.rate).toBeGreaterThanOrEqual(previous.rate);
    }
  });

  it('eases toward the target rate and gets there', () => {
    let state: StrobePhase = { phase: 0, rate: 0 };
    for (let i = 0; i < 60; i += 1) state = advanceStrobe(state, 5, 1 / 60);
    expect(state.rate).toBeCloseTo(5, 3);
  });

  it('clamps a monstrous frame step instead of teleporting the pattern', () => {
    const stalled = advanceStrobe({ phase: 0, rate: 4 }, 4, 30);
    const clamped = advanceStrobe({ phase: 0, rate: 4 }, 4, 0.05);
    expect(stalled).toEqual(clamped);
  });
});
