import type { MidiEvent, MidiTrigger, RackModule, RoutingState } from './types';
import { MIDI_PRESS_THRESHOLD, isPress, triggerOf } from './midi';

/**
 * Pure dispatch logic for MIDI bound to rig content — knobs, module bypass,
 * lane switches — as opposed to the global actions in AppSettings.midiBindings
 * (see midi.ts). No engine or UI imports, so the whole decision table is
 * unit-testable.
 *
 * Precedence contract: rig content owns a trigger identity outright. The
 * dispatcher must consume any event whose trigger is in the content table even
 * when it resolves to no command (a release) — otherwise a footswitch's
 * release would fall through and fire a global action.
 */

export type ContentTarget =
  | { kind: 'knob'; moduleId: string; paramIndex: number; isBoolean: boolean }
  | { kind: 'module'; moduleId: string }
  | { kind: 'lane'; groupId: string; laneId: string };

export type ContentCommand =
  | { kind: 'setParam'; moduleId: string; paramIndex: number; value: number }
  | { kind: 'toggleParam'; moduleId: string; paramIndex: number }
  | { kind: 'toggleBypass'; moduleId: string }
  | { kind: 'laneSwitch'; groupId: string; laneId: string };

/** A binding's owner, for the steal-on-learn sweep. */
export type ContentBindingRef =
  | { kind: 'knob'; moduleId: string; knobId: string }
  | { kind: 'module'; moduleId: string }
  | { kind: 'lane'; laneId: string };

/** Map key for a trigger identity — everything except the value. */
export function triggerKey(trigger: MidiTrigger): string {
  return `${trigger.type}:${trigger.channel}:${trigger.number}`;
}

/** The patch a meter toggle applies to a knob mapping, shared by both
    engines. Enabling the meter also drops any MIDI binding: meters never
    carry one (a meter shows neither the learn nor the clear control), and a
    binding that quietly survived would re-arm the footswitch the moment the
    knob was converted back. Convert-back does not restore it. */
export function knobMeterPatch(isMeter: boolean): { isMeter: boolean; midi?: MidiTrigger } {
  return isMeter ? { isMeter, midi: undefined } : { isMeter };
}

/** Trigger-key → target over the whole rig. Meters are skipped even if a
    stale binding sits on one (never learnable, never dispatchable). Duplicate
    triggers — possible only via hand-edited files — resolve to the first
    owner in rack order then routing order, so dispatch is deterministic. */
export function buildContentTargets(
  rack: RackModule[],
  routing: RoutingState,
): Map<string, ContentTarget> {
  const targets = new Map<string, ContentTarget>();
  const claim = (trigger: MidiTrigger | undefined, target: ContentTarget) => {
    if (!trigger) return;
    const key = triggerKey(trigger);
    if (!targets.has(key)) targets.set(key, target);
  };

  for (const module of rack) {
    claim(module.midi, { kind: 'module', moduleId: module.id });
    for (const param of module.params) {
      if (param.isMeter) continue;
      claim(param.midi, {
        kind: 'knob',
        moduleId: module.id,
        paramIndex: param.paramIndex,
        isBoolean: !!param.isBoolean,
      });
    }
  }

  for (const group of routing.groups)
    for (const lane of group.lanes)
      claim(lane.midi, { kind: 'lane', groupId: group.id, laneId: lane.id });

  return targets;
}

/** What a MIDI event does to rig content, or null (a release, or a message
    kind the target ignores). Null does NOT mean "fall through to global" —
    the caller consumes any event whose trigger identity is in the table. */
export function resolveContentMidi(
  targets: ReadonlyMap<string, ContentTarget>,
  event: MidiEvent,
): ContentCommand | null {
  const target = targets.get(triggerKey(triggerOf(event)));
  if (!target) return null;

  switch (target.kind) {
    case 'knob':
      if (target.isBoolean) {
        // A CC tracks the switch position, so latching footswitches work; a
        // note/PC (always a press) toggles, for momentary switches.
        if (event.type === 'cc')
          return {
            kind: 'setParam',
            moduleId: target.moduleId,
            paramIndex: target.paramIndex,
            value: event.value >= MIDI_PRESS_THRESHOLD ? 1 : 0,
          };
        return { kind: 'toggleParam', moduleId: target.moduleId, paramIndex: target.paramIndex };
      }
      // Continuous knob: every CC value counts, including below the press
      // threshold — a pedal sweep is all "releases" on its way down. Note/PC
      // are only reachable from a hand-edited file (learn accepts CC only).
      if (event.type !== 'cc') return null;
      return {
        kind: 'setParam',
        moduleId: target.moduleId,
        paramIndex: target.paramIndex,
        value: event.value / 127,
      };

    case 'module':
      return isPress(event) ? { kind: 'toggleBypass', moduleId: target.moduleId } : null;

    case 'lane':
      // A press while the group is in mix mode activates switch mode on this
      // lane — the same thing selecting a lane from the UI does.
      return isPress(event)
        ? { kind: 'laneSwitch', groupId: target.groupId, laneId: target.laneId }
        : null;
  }
}

/** Every rig-content owner of a trigger — a learn capture clears these before
    binding, so one switch never drives two things by accident. */
export function findContentBindings(
  rack: RackModule[],
  routing: RoutingState,
  trigger: MidiTrigger,
): ContentBindingRef[] {
  const key = triggerKey(trigger);
  const owners: ContentBindingRef[] = [];

  for (const module of rack) {
    if (module.midi && triggerKey(module.midi) === key)
      owners.push({ kind: 'module', moduleId: module.id });
    for (const param of module.params)
      if (param.midi && triggerKey(param.midi) === key)
        owners.push({ kind: 'knob', moduleId: module.id, knobId: param.knobId });
  }

  for (const group of routing.groups)
    for (const lane of group.lanes)
      if (lane.midi && triggerKey(lane.midi) === key)
        owners.push({ kind: 'lane', laneId: lane.id });

  return owners;
}
