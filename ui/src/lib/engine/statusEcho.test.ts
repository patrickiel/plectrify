import { describe, expect, it } from 'vitest';
import { STATUS_ECHO_CONFIRM_MS, notePendingStatus, reconcileStatusPush } from './statusEcho';
import type { PendingStatusWrites } from './statusEcho';

describe('status echo guard', () => {
  it('drops a stale pre-write value until the echo lands', () => {
    const pending: PendingStatusWrites = new Map();
    notePendingStatus(pending, { noiseGateEnabled: true }, 0);
    // The tick snapshotted before the click still says off.
    expect(reconcileStatusPush(pending, { noiseGateEnabled: false, inputPeak: 0.3 }, 70)).toEqual({
      inputPeak: 0.3,
    });
    // The echo confirms and clears the entry.
    expect(reconcileStatusPush(pending, { noiseGateEnabled: true }, 140)).toEqual({
      noiseGateEnabled: true,
    });
    expect(pending.size).toBe(0);
    // Later pushes pass untouched.
    expect(reconcileStatusPush(pending, { noiseGateEnabled: false }, 210)).toEqual({
      noiseGateEnabled: false,
    });
  });

  it('gives up at the deadline so a refused write cannot pin the page', () => {
    const pending: PendingStatusWrites = new Map();
    notePendingStatus(pending, { outputGainDb: 6 }, 0);
    expect(reconcileStatusPush(pending, { outputGainDb: 0 }, STATUS_ECHO_CONFIRM_MS - 1)).toEqual(
      {},
    );
    expect(reconcileStatusPush(pending, { outputGainDb: 0 }, STATUS_ECHO_CONFIRM_MS)).toEqual({
      outputGainDb: 0,
    });
    expect(pending.size).toBe(0);
  });

  it('leaves keys it is not waiting on alone and compares arrays by value', () => {
    const pending: PendingStatusWrites = new Map();
    notePendingStatus(pending, { metronomeAccents: [2, 0, 1, 0] }, 0);
    expect(
      reconcileStatusPush(pending, { metronomeAccents: [2, 0, 1, 0], metronomeBpm: 120 }, 10),
    ).toEqual({ metronomeAccents: [2, 0, 1, 0], metronomeBpm: 120 });
    expect(pending.size).toBe(0);
  });

  it('confirms a float field echoed at the engine’s float precision', () => {
    const pending: PendingStatusWrites = new Map();
    notePendingStatus(pending, { noiseGateAttackMs: 0.3 }, 0);
    expect(reconcileStatusPush(pending, { noiseGateAttackMs: Math.fround(0.3) }, 10)).toEqual({
      noiseGateAttackMs: Math.fround(0.3),
    });
    expect(pending.size).toBe(0);
  });

  it('a newer write replaces the expectation', () => {
    const pending: PendingStatusWrites = new Map();
    notePendingStatus(pending, { outputMuted: true }, 0);
    notePendingStatus(pending, { outputMuted: false }, 20);
    expect(reconcileStatusPush(pending, { outputMuted: true }, 40)).toEqual({});
    expect(reconcileStatusPush(pending, { outputMuted: false }, 60)).toEqual({
      outputMuted: false,
    });
  });
});
