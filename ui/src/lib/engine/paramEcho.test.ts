import { describe, expect, it } from 'vitest';
import {
  PARAM_ECHO_CONFIRM_MS,
  isStaleEcho,
  notePendingParamWrite,
  type PendingEchoes,
} from './paramEcho';

const MOD = 'm1';
const IDX = 0;

/** A guard armed by one write of `expected` over `prev`, at t=0. */
const armed = (expected: number, prev: number | undefined): PendingEchoes => {
  const pending: PendingEchoes = new Map();
  notePendingParamWrite(pending, MOD, IDX, expected, prev, 0);
  return pending;
};

const echo = (pending: PendingEchoes, value: number, now = 0) =>
  isStaleEcho(pending, MOD, IDX, value, now);

describe('param echo guard', () => {
  it('does not suppress when nothing is pending', () => {
    expect(echo(new Map(), 0.3)).toBe(false);
  });

  it('suppresses a tick still carrying the pre-write value', () => {
    expect(echo(armed(0.8, 0.3), 0.3)).toBe(true);
  });

  it('accepts the confirming echo and disarms', () => {
    const pending = armed(0.8, 0.3);
    expect(echo(pending, 0.8)).toBe(false);
    // Disarmed: a later legitimate return to the pre-write value is not eaten.
    expect(echo(pending, 0.3)).toBe(false);
  });

  it('disarms on a bit-exact confirmation, which the caller may then skip', () => {
    // The scene-apply path re-writes a value that came from an earlier echo, so
    // it is float32-representable and the confirming echo is bit-identical to
    // the optimistic value. The guard must still see it.
    const value = Math.fround(0.573451220989227);
    const pending = armed(value, 0.3);
    expect(echo(pending, value)).toBe(false);
    expect(echo(pending, 0.3)).toBe(false);
  });

  it('accepts a third value the plugin snapped to', () => {
    const pending = armed(0.8, 0.3);
    expect(echo(pending, 0.55)).toBe(false);
    expect(echo(pending, 0.3)).toBe(false);
  });

  it('never suppresses when there was no pre-write value', () => {
    expect(echo(armed(0.8, undefined), 0.3)).toBe(false);
  });

  it('stands down after two consecutive pre-write echoes', () => {
    // A plugin that resolves the write back to its previous value is
    // authoritative, not stale — bounded to ~2 ticks rather than the deadline.
    const pending = armed(0.8, 0.3);
    expect(echo(pending, 0.3)).toBe(true);
    expect(echo(pending, 0.3)).toBe(false);
    expect(echo(pending, 0.3)).toBe(false);
  });

  it('treats values within the scene epsilon as the same value', () => {
    const pending = armed(0.8, 0.3);
    expect(echo(pending, 0.30005)).toBe(true);
    expect(echo(pending, Math.fround(0.8))).toBe(false);
  });

  it('drops the entry once the deadline passes', () => {
    const pending = armed(0.8, 0.3);
    expect(echo(pending, 0.3, PARAM_ECHO_CONFIRM_MS + 1)).toBe(false);
    expect(echo(pending, 0.3)).toBe(false);
  });

  it('keeps the original pre-write value across a drag, and re-arms the count', () => {
    const pending: PendingEchoes = new Map();
    notePendingParamWrite(pending, MOD, IDX, 0.4, 0.3, 0);
    expect(echo(pending, 0.3)).toBe(true);
    notePendingParamWrite(pending, MOD, IDX, 0.5, 0.4, 10);
    notePendingParamWrite(pending, MOD, IDX, 0.6, 0.5, 20);
    // Still guarding 0.3 — the value in-flight ticks carry — and the count
    // restarted, so the first of them is suppressed again.
    expect(echo(pending, 0.3, 30)).toBe(true);
    // The intermediate drag values are third values: authoritative, so they
    // stand the guard down rather than being mistaken for stale ticks.
    const dragging = armed(0.6, 0.3);
    expect(echo(dragging, 0.5)).toBe(false);
  });

  it('extends the deadline on each write of a drag', () => {
    const pending: PendingEchoes = new Map();
    notePendingParamWrite(pending, MOD, IDX, 0.4, 0.3, 0);
    notePendingParamWrite(pending, MOD, IDX, 0.9, 0.4, 2_000);
    expect(echo(pending, 0.3, PARAM_ECHO_CONFIRM_MS + 1)).toBe(true);
  });

  it('tracks params and modules independently', () => {
    const pending = armed(0.8, 0.3);
    expect(isStaleEcho(pending, MOD, 1, 0.3, 0)).toBe(false);
    expect(isStaleEcho(pending, 'm2', IDX, 0.3, 0)).toBe(false);
    expect(echo(pending, 0.3)).toBe(true);
  });
});
