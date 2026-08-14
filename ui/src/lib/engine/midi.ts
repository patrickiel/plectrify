import type { MidiActionId, MidiEvent, MidiTrigger } from './types';

/**
 * Pure MIDI binding logic: press detection, trigger matching, learn-time
 * assignment. No engine or UI imports, so the whole table of behaviours is
 * unit-testable.
 *
 * Press semantics: an action fires on every eligible press — any program
 * change, any note-on (the engine already drops velocity-0 note-ons), and any
 * CC at or above MIDI_PRESS_THRESHOLD. A momentary footswitch sending 127 on
 * press and 0 on release therefore fires exactly once, with no edge state
 * needed. Known limitation: a controller that sends 127 on both press *and*
 * release double-fires — tracking edges would fix it but would break latching
 * switches that alternate 127/0 per press, so the matcher stays stateless.
 */

/** CC values at or above this count as a press; below is a release. */
export const MIDI_PRESS_THRESHOLD = 64;

/** Whether a value is a well-formed trigger: known kind, channel 1-16,
    number 0-127. Shared by the settings normalizer and rig-file loading. */
export function isMidiTrigger(value: unknown): value is MidiTrigger {
  if (typeof value !== 'object' || value === null) return false;
  const trigger = value as Partial<MidiTrigger>;
  return (
    (trigger.type === 'cc' || trigger.type === 'pc' || trigger.type === 'note') &&
    Number.isInteger(trigger.channel) &&
    (trigger.channel as number) >= 1 &&
    (trigger.channel as number) <= 16 &&
    Number.isInteger(trigger.number) &&
    (trigger.number as number) >= 0 &&
    (trigger.number as number) <= 127
  );
}

/** A persisted trigger rebuilt field by field, or undefined when malformed —
    load-time stripping for rig files and the working session, so stray extra
    properties never survive a round-trip. */
export function sanitizeTrigger(value: unknown): MidiTrigger | undefined {
  return isMidiTrigger(value)
    ? { type: value.type, channel: value.channel, number: value.number }
    : undefined;
}

/** Whether this message counts as a press (fires actions, learnable). */
export function isPress(event: MidiEvent): boolean {
  return event.type === 'cc' ? event.value >= MIDI_PRESS_THRESHOLD : true;
}

/** The binding identity of a message: everything except its value. */
export function triggerOf(event: MidiEvent): MidiTrigger {
  return { type: event.type, channel: event.channel, number: event.number };
}

export function triggersEqual(a: MidiTrigger, b: MidiTrigger): boolean {
  return a.type === b.type && a.channel === b.channel && a.number === b.number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Short human label for a learned trigger, e.g. "CC 25 · ch 1",
    "PC 5 · ch 1", "Note C#2 · ch 10". Octave numbering follows middle C = C3
    (note 60), the common convention on foot controllers. */
export function describeTrigger(trigger: MidiTrigger): string {
  const channel = `ch ${trigger.channel}`;
  if (trigger.type === 'cc') return `CC ${trigger.number} · ${channel}`;
  if (trigger.type === 'pc') return `PC ${trigger.number} · ${channel}`;
  const name = NOTE_NAMES[trigger.number % 12];
  const octave = Math.floor(trigger.number / 12) - 2;
  return `Note ${name}${octave} · ${channel}`;
}

/** The action a message fires, or null: not a press, or nothing bound to it. */
export function matchMidi(
  bindings: Record<string, MidiTrigger>,
  event: MidiEvent,
): MidiActionId | null {
  if (!isPress(event)) return null;
  const trigger = triggerOf(event);
  for (const [action, bound] of Object.entries(bindings))
    if (triggersEqual(bound, trigger)) return action as MidiActionId;
  return null;
}

/** Bind a trigger to an action, stealing it from any action it was bound to
    (last learn wins — the stolen row simply goes empty in the dialog). */
export function assignBinding(
  bindings: Record<string, MidiTrigger>,
  actionId: MidiActionId,
  trigger: MidiTrigger,
): Record<string, MidiTrigger> {
  const next = Object.fromEntries(
    Object.entries(bindings).filter(([, bound]) => !triggersEqual(bound, trigger)),
  );
  next[actionId] = trigger;
  return next;
}

export function clearBinding(
  bindings: Record<string, MidiTrigger>,
  actionId: MidiActionId,
): Record<string, MidiTrigger> {
  const next = { ...bindings };
  delete next[actionId];
  return next;
}

/** Drop every binding in `actionIds` at once — the dialog's per-section
    "Clear all". Scoped to the ids handed in rather than emptying the table, so
    clearing the rigs never touches the scenes (or the tuner's own binding).
    Ids that aren't bound are simply absent from the result. */
export function clearBindings(
  bindings: Record<string, MidiTrigger>,
  actionIds: readonly MidiActionId[],
): Record<string, MidiTrigger> {
  const dropped = new Set<string>(actionIds);
  return Object.fromEntries(
    Object.entries(bindings).filter(([actionId]) => !dropped.has(actionId)),
  );
}

/** Next/prev index over a wrap-around list. `current` is -1-safe: with no
    active item, next lands on the first and prev on the last. Returns -1 only
    for an empty list. */
export function stepIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
