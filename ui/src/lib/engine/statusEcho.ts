import type { StatusState } from './types';

/**
 * The status bar's answer to paramEcho: optimistic status writes awaiting
 * their engine echo.
 *
 * `setStatus` applies a write to the page's copy at once — a pill must light
 * the instant it is clicked — and emits it to the engine, whose 15 Hz
 * `statusChanged` stream then re-states every field. But a tick can already be
 * in flight when the write is emitted, snapshotted *before* the engine handled
 * it; merged blindly, it reverts the field for one tick until the next push
 * carries the new value. On a pill that is a flash. So each written key is
 * remembered with the value it should come back as, and until a push carries
 * that value (or anything other than the stale pre-write one would, but status
 * fields are not constrained by a plugin the way a parameter is, so "the
 * expected value" is the only confirmation) the key is dropped from incoming
 * pushes. A deadline bounds the wait so a write the engine refused cannot pin
 * the page forever.
 */
export const STATUS_ECHO_CONFIRM_MS = 1_500;

export interface PendingStatusWrite {
  expected: unknown;
  deadline: number;
}

export type PendingStatusWrites = Map<keyof StatusState, PendingStatusWrite>;

// Numbers compare at float precision: the engine keeps these fields as
// `std::atomic<float>` and echoes the widened value, so a written 0.3 comes
// back as 0.30000001192… and would otherwise never confirm.
const same = (a: unknown, b: unknown) =>
  Object.is(a, b) ||
  (typeof a === 'number' && typeof b === 'number' && Math.fround(a) === Math.fround(b)) ||
  (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Records an optimistic write. Call before emitting it to the engine. */
export function notePendingStatus(
  pending: PendingStatusWrites,
  write: Partial<StatusState>,
  now: number,
): void {
  for (const key of Object.keys(write) as (keyof StatusState)[]) {
    pending.set(key, { expected: write[key], deadline: now + STATUS_ECHO_CONFIRM_MS });
  }
}

/** Filters an incoming push: keys still awaiting their echo and not yet
    carrying it are removed, so the page's optimistic value stands; a key whose
    echo has arrived, or whose deadline has passed, is accepted and forgotten. */
export function reconcileStatusPush(
  pending: PendingStatusWrites,
  push: Partial<StatusState>,
  now: number,
): Partial<StatusState> {
  if (pending.size === 0) return push;
  const result: Partial<StatusState> = { ...push };
  for (const [key, entry] of pending) {
    if (!(key in push)) continue;
    if (same(push[key], entry.expected) || now >= entry.deadline) {
      pending.delete(key);
      continue;
    }
    delete result[key];
  }
  return result;
}
