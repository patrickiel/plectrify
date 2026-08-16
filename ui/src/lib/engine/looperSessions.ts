import type { LooperSession } from './types';

/** Where the engine archives cleared loops (WAVs + the TS-owned index). */
export const LOOPER_SESSION_DIR = 'looper-sessions';
export const LOOPER_SESSION_INDEX = `${LOOPER_SESSION_DIR}/index.json`;

/** How many un-kept sessions the archive holds before the oldest are pruned.
    Sessions the user marked as kept are exempt and don't count toward the cap
    — "keep" means exactly "never auto-discarded". ~20 MB per minute of loop,
    so the worst uncapped growth is bounded by the user's own kept list. */
export const LOOPER_SESSION_CAP = 20;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Default display name for a session: its moment of capture ("Aug 6, 14:32").
    Fixed format rather than locale-dependent so the list stays predictable. */
export function looperSessionName(createdAt: number): string {
  const d = new Date(createdAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

/** Parses an index file's content into a clean session list, dropping
    malformed entries rather than failing the whole list. */
export function normalizeLooperSessions(parsed: unknown): LooperSession[] {
  if (!Array.isArray(parsed)) return [];
  const sessions: LooperSession[] = [];
  for (const raw of parsed as Partial<LooperSession>[]) {
    if (typeof raw?.id !== 'string' || !raw.id) continue;
    if (typeof raw.file !== 'string' || !raw.file) continue;
    const durationSeconds = Number(raw.durationSeconds);
    const createdAt = Number(raw.createdAt);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) continue;
    if (!Number.isFinite(createdAt)) continue;
    sessions.push({
      id: raw.id,
      file: raw.file,
      durationSeconds,
      createdAt,
      name: typeof raw.name === 'string' && raw.name ? raw.name : looperSessionName(createdAt),
      kept: raw.kept === true,
    });
  }
  return sessions;
}

/** Applies the size cap to a newest-first list: the oldest un-kept sessions
    past the cap move to `drop` (their WAVs are the caller's to delete); kept
    sessions always survive and never count toward the cap. */
export function pruneLooperSessions(
  sessions: LooperSession[],
  cap = LOOPER_SESSION_CAP,
): { keep: LooperSession[]; drop: LooperSession[] } {
  const drop: LooperSession[] = [];
  let unkept = 0;
  const keep = sessions.filter((s) => {
    if (s.kept) return true;
    unkept += 1;
    if (unkept > cap) {
      drop.push(s);
      return false;
    }
    return true;
  });
  return { keep, drop };
}
