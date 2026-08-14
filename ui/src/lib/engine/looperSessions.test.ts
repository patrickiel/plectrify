import { describe, expect, it } from 'vitest';
import {
  LOOPER_SESSION_CAP,
  looperSessionName,
  normalizeLooperSessions,
  pruneLooperSessions,
} from './looperSessions';
import type { LooperSession } from './types';

const session = (over: Partial<LooperSession>): LooperSession => ({
  id: 'take-1',
  name: 'Aug 6, 14:32',
  file: 'session-20260806-143200.wav',
  durationSeconds: 4,
  createdAt: 1_770_000_000_000,
  kept: false,
  ...over,
});

describe('looperSessionName', () => {
  it('formats the capture moment as "Mon D, HH:MM"', () => {
    // Local time on purpose: the list shows the player's clock.
    const d = new Date(2026, 7, 6, 14, 32);
    expect(looperSessionName(d.getTime())).toBe('Aug 6, 14:32');
  });

  it('pads single-digit hours and minutes', () => {
    const d = new Date(2026, 0, 3, 9, 5);
    expect(looperSessionName(d.getTime())).toBe('Jan 3, 09:05');
  });
});

describe('normalizeLooperSessions', () => {
  it('rejects anything that is not an array', () => {
    expect(normalizeLooperSessions(null)).toEqual([]);
    expect(normalizeLooperSessions({})).toEqual([]);
    expect(normalizeLooperSessions('[]')).toEqual([]);
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    const good = session({});
    const result = normalizeLooperSessions([
      good,
      { ...session({}), id: '' }, // no identity
      { ...session({}), file: 42 }, // no file
      { ...session({}), durationSeconds: -1 }, // negative length
      { ...session({}), createdAt: 'yesterday' }, // no timestamp
    ]);
    expect(result).toEqual([good]);
  });

  it('backfills a missing name from the timestamp and coerces kept to boolean', () => {
    const raw = {
      ...session({ createdAt: new Date(2026, 7, 6, 14, 32).getTime() }),
      name: '',
      kept: 'yes',
    };
    const [entry] = normalizeLooperSessions([raw]);
    expect(entry.name).toBe('Aug 6, 14:32');
    expect(entry.kept).toBe(false); // only a literal true counts
  });
});

describe('pruneLooperSessions', () => {
  const many = (count: number, over: (index: number) => Partial<LooperSession> = () => ({})) =>
    Array.from({ length: count }, (_, i) => session({ id: `take-${i}`, ...over(i) }));

  it('leaves a list at or under the cap untouched', () => {
    const sessions = many(LOOPER_SESSION_CAP);
    expect(pruneLooperSessions(sessions)).toEqual({ keep: sessions, drop: [] });
  });

  it('drops the oldest entries past the cap (list is newest first)', () => {
    const sessions = many(5);
    const { keep, drop } = pruneLooperSessions(sessions, 3);
    expect(keep.map((s) => s.id)).toEqual(['take-0', 'take-1', 'take-2']);
    expect(drop.map((s) => s.id)).toEqual(['take-3', 'take-4']);
  });

  it('never drops kept sessions and excludes them from the count', () => {
    // 2 kept among 6, cap 3: the kept two survive wherever they sit, and
    // three un-kept survive on top of them.
    const sessions = many(6, (i) => ({ kept: i === 1 || i === 5 }));
    const { keep, drop } = pruneLooperSessions(sessions, 3);
    expect(keep.map((s) => s.id)).toEqual(['take-0', 'take-1', 'take-2', 'take-3', 'take-5']);
    expect(drop.map((s) => s.id)).toEqual(['take-4']);
  });
});
