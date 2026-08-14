import type { LaneMix, RoutingState } from './types';
import { uid } from './ids';
import { sanitizeTrigger } from './midi';

/** The default name for the lane in the nth slot of a group: A, B, C… */
export function laneName(index: number): string {
  return String.fromCharCode(65 + index);
}

/** The first default letter not already taken in a group, so adding a lane
    next to a renamed one still lands on an unused name. */
export function nextLaneName(lanes: Pick<LaneMix, 'name'>[]): string {
  const taken = new Set(lanes.map((lane) => lane.name));
  let index = 0;
  while (taken.has(laneName(index))) index++;
  return laneName(index);
}

/** A fresh parallel lane at unity gain, centred, unmuted. */
export function makeLane(name: string): LaneMix {
  return { id: uid('lane'), name, gain: 1, pan: 0, muted: false, soloed: false };
}

/**
 * Accepts the current `{groups}` routing shape, migrates the legacy
 * single-group shape (`{lanes, groupPosition}` from before sequential splits
 * existed), and degrades anything else to "no routing". Lanes carrying no name
 * — snapshots written before names existed, and every echo from C++, which
 * only tracks audio truth — fall back to their positional letter. Groups are
 * references into `value`; their lane arrays are freshly built.
 */
export function normalizeRoutingState(value: unknown): RoutingState {
  const raw = value as
    | { groups?: RoutingState['groups']; groupPosition?: number | null; lanes?: LaneMix[] }
    | null
    | undefined;
  if (Array.isArray(raw?.groups))
    return {
      groups: raw.groups
        .filter(isObject)
        .map((group) => ({ ...group, lanes: namedLanes(group.lanes) })),
    };
  if (Array.isArray(raw?.lanes) && raw.lanes.length >= 2)
    return {
      groups: [
        { id: uid('group'), position: raw.groupPosition ?? 0, lanes: namedLanes(raw.lanes) },
      ],
    };
  return { groups: [] };
}

function namedLanes(lanes: LaneMix[] | undefined): LaneMix[] {
  // The MIDI trigger is validated on the same pass: this is the one funnel
  // every stored or echoed routing goes through, so a malformed binding from
  // a hand-edited file can never reach dispatch.
  return (Array.isArray(lanes) ? lanes : []).filter(isObject).map((lane, index) => ({
    ...lane,
    name: lane.name?.trim() || laneName(index),
    midi: sanitizeTrigger(lane.midi),
  }));
}

/** Guards the "degrades anything else" promise above: a hand-edited file can
    put a null or a scalar where a group or a lane belongs, and normalizing has
    to drop it rather than throw — a rack whose routing is unusable still has
    modules worth restoring. */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}
