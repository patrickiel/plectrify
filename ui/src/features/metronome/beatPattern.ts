export type BeatLevel = 0 | 1 | 2 | 3;

export const DEFAULT_PATTERN: BeatLevel[] = [3, 2, 2, 2];
export const MAX_BEATS_PER_BAR = 12;

function beatCount(value: number): number {
  return Math.max(1, Math.min(MAX_BEATS_PER_BAR, Math.floor(value)));
}

/** Tap through the three UI states: off → normal → accent → off. Level 1
    (soft) only exists in old stored patterns and advances to normal. */
export function cycleLevel(level: BeatLevel): BeatLevel {
  if (level === 0 || level === 1) return 2;
  return level === 2 ? 3 : 0;
}

/** The three states in strength order, for wheel-stepping (which, unlike the
    click cycle, clamps at the ends instead of wrapping). */
const LEVELS: BeatLevel[] = [0, 2, 3];

export function stepLevel(level: BeatLevel, direction: number): BeatLevel {
  const index = Math.max(0, LEVELS.indexOf(level === 1 ? 2 : level));
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index + direction))];
}

/** Preserve existing accents, truncating or padding new beats as normal. */
export function resizePattern(pattern: readonly BeatLevel[], beatsPerBar: number): BeatLevel[] {
  const size = beatCount(beatsPerBar);
  return Array.from({ length: size }, (_, index) => pattern[index] ?? 2);
}

/** Validate engine/stored data as one coherent pattern; malformed input falls
    back as a whole instead of mixing trusted and untrusted beat levels. The
    legacy soft level (1) maps to normal so every beat lands on a UI state. */
export function sanitizePattern(value: unknown, beatsPerBar: number): BeatLevel[] {
  const size = beatCount(beatsPerBar);
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    value.some((level) => !Number.isInteger(level) || level < 0 || level > 3)
  )
    return resizePattern(DEFAULT_PATTERN, size);
  return value.map((level) => (level === 1 ? 2 : level)) as BeatLevel[];
}
