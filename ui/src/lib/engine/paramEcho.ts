import { SCENE_VALUE_EPSILON } from './scenes';

/** How long an optimistic param write may wait for its confirming echo before
    the stale-echo guard stands down. The native 15 Hz stream usually confirms
    within two ticks (~130 ms), but the message thread can stall for hundreds
    of ms right after a whole-rack apply, holding both the write and its echo
    in the queue — sized to ride that out. This is the outer backstop only;
    PARAM_ECHO_PREV_TICKS ends the common case far sooner. */
export const PARAM_ECHO_CONFIRM_MS = 3_000;

/** How many consecutive echoes still carrying the pre-write value are assumed
    stale before the guard gives up and accepts them. Staleness is identified by
    value alone, so a plugin that resolves a write back to its exact pre-write
    value (a stepped or constrained parameter rejecting the write) is
    indistinguishable from a tick snapshotted before the write landed — this
    bounds how long that authoritative snapback is ignored to ~2 ticks (~130 ms)
    instead of the full deadline. The tradeoff: if more than two pre-write ticks
    were queued at once, the knob shows a one-tick flicker before the real echo
    lands. */
const PARAM_ECHO_PREV_TICKS = 2;

/** One optimistic param write awaiting its engine echo. `prevTicks` counts the
    echoes seen so far that still carry `prev`. */
export interface PendingWrite {
  expected: number;
  prev: number | undefined;
  deadline: number;
  prevTicks: number;
}

/** Optimistic param writes awaiting their engine echo. The 15 Hz value stream
    can deliver a tick snapshotted BEFORE the write was processed (the tick was
    already in flight when the write was emitted); accepting it would revert the
    optimistic value until the true echo lands — which can be hundreds of ms
    later when the message thread stalls after an apply. While an entry is
    pending, an echo still carrying the pre-write value is dropped; the expected
    value (or any third value the plugin snapped to) confirms and clears it.
    Keyed module -> paramIndex. */
export type PendingEchoes = Map<string, Map<number, PendingWrite>>;

/** Arm the stale-echo guard for one optimistic param write. A repeated write to
    the same param (a drag) keeps the original pre-write value: that is the value
    stale ticks still carry. */
export function notePendingParamWrite(
  pending: PendingEchoes,
  moduleId: string,
  paramIndex: number,
  expected: number,
  prev: number | undefined,
  now: number,
): void {
  let byMod = pending.get(moduleId);
  if (!byMod) pending.set(moduleId, (byMod = new Map()));
  const existing = byMod.get(paramIndex);
  byMod.set(paramIndex, {
    expected,
    prev: existing ? existing.prev : prev,
    deadline: now + PARAM_ECHO_CONFIRM_MS,
    // A fresh write restarts the count: the ticks that could be stale are the
    // ones in flight for THIS write.
    prevTicks: 0,
  });
}

/** The stale-echo guard: true when this incoming value must be ignored because
    it predates a still-unconfirmed optimistic write. Callers must run this
    before any short circuit that skips an unchanged value, or a bit-exact
    confirming echo would leave the entry armed until its deadline. */
export function isStaleEcho(
  pending: PendingEchoes,
  moduleId: string,
  paramIndex: number,
  value: number,
  now: number,
): boolean {
  const byMod = pending.get(moduleId);
  const write = byMod?.get(paramIndex);
  if (!byMod || !write) return false;
  if (now > write.deadline) {
    byMod.delete(paramIndex);
    return false;
  }
  // The write came back (or the plugin snapped it to a third value, which
  // is just as authoritative) — confirmed either way, guard stands down.
  if (
    Math.abs(value - write.expected) <= SCENE_VALUE_EPSILON ||
    write.prev === undefined ||
    Math.abs(value - write.prev) > SCENE_VALUE_EPSILON
  ) {
    byMod.delete(paramIndex);
    return false;
  }
  // Still the pre-write value: a tick snapshotted before the write landed —
  // until enough of them arrive that the plugin is clearly reporting it back
  // on purpose.
  if (++write.prevTicks >= PARAM_ECHO_PREV_TICKS) {
    byMod.delete(paramIndex);
    return false;
  }
  return true;
}
