import { describe, expect, it } from 'vitest';
import {
  MIDI_PRESS_THRESHOLD,
  assignBinding,
  clearBinding,
  clearBindings,
  describeTrigger,
  isMidiTrigger,
  isPress,
  matchMidi,
  sanitizeTrigger,
  stepIndex,
  triggerOf,
  triggersEqual,
} from './midi';
import type { MidiEvent, MidiTrigger } from './types';

const cc = (number: number, value: number, channel = 1): MidiEvent => ({
  type: 'cc',
  channel,
  number,
  value,
});
const pc = (number: number, channel = 1): MidiEvent => ({ type: 'pc', channel, number, value: 0 });
const note = (number: number, velocity = 100, channel = 1): MidiEvent => ({
  type: 'note',
  channel,
  number,
  value: velocity,
});

describe('isPress', () => {
  it('treats a CC at or above the threshold as a press, below as a release', () => {
    expect(isPress(cc(25, MIDI_PRESS_THRESHOLD))).toBe(true);
    expect(isPress(cc(25, 127))).toBe(true);
    expect(isPress(cc(25, MIDI_PRESS_THRESHOLD - 1))).toBe(false);
    expect(isPress(cc(25, 0))).toBe(false);
  });

  it('treats every program change and note-on as a press', () => {
    expect(isPress(pc(5))).toBe(true);
    expect(isPress(note(60, 1))).toBe(true);
  });
});

describe('matchMidi', () => {
  const bindings: Record<string, MidiTrigger> = {
    'rig:0': { type: 'cc', channel: 1, number: 25 },
    tunerToggle: { type: 'note', channel: 10, number: 61 },
    sceneNext: { type: 'pc', channel: 1, number: 5 },
  };

  it('fires the bound action on a press of the exact trigger', () => {
    expect(matchMidi(bindings, cc(25, 127))).toBe('rig:0');
    expect(matchMidi(bindings, pc(5))).toBe('sceneNext');
    expect(matchMidi(bindings, note(61, 90, 10))).toBe('tunerToggle');
  });

  it('ignores releases of a bound CC', () => {
    expect(matchMidi(bindings, cc(25, 0))).toBeNull();
  });

  it('requires channel, number and type to all match', () => {
    expect(matchMidi(bindings, cc(25, 127, 2))).toBeNull(); // wrong channel
    expect(matchMidi(bindings, cc(26, 127))).toBeNull(); // wrong number
    expect(matchMidi(bindings, note(25, 100))).toBeNull(); // wrong type, same number
  });

  it('returns null for anything unmapped', () => {
    expect(matchMidi({}, cc(25, 127))).toBeNull();
    expect(matchMidi(bindings, pc(6))).toBeNull();
  });
});

describe('assignBinding / clearBinding', () => {
  it('binds a trigger and steals it from any other action (last learn wins)', () => {
    const trigger: MidiTrigger = { type: 'cc', channel: 1, number: 25 };
    const first = assignBinding({}, 'rig:0', trigger);
    expect(first).toEqual({ 'rig:0': trigger });

    const stolen = assignBinding(first, 'tunerToggle', trigger);
    expect(stolen).toEqual({ tunerToggle: trigger });
  });

  it('leaves unrelated bindings alone', () => {
    const other: MidiTrigger = { type: 'pc', channel: 1, number: 5 };
    const bindings = assignBinding({ sceneNext: other }, 'rig:0', {
      type: 'cc',
      channel: 1,
      number: 25,
    });
    expect(bindings.sceneNext).toEqual(other);
  });

  it('re-learning the same action just replaces its trigger', () => {
    const bindings = assignBinding({ 'rig:0': { type: 'cc', channel: 1, number: 25 } }, 'rig:0', {
      type: 'cc',
      channel: 1,
      number: 26,
    });
    expect(bindings).toEqual({ 'rig:0': { type: 'cc', channel: 1, number: 26 } });
  });

  it('clears a binding and tolerates clearing an unbound action', () => {
    const bindings = { 'rig:0': { type: 'cc', channel: 1, number: 25 } as MidiTrigger };
    expect(clearBinding(bindings, 'rig:0')).toEqual({});
    expect(clearBinding({}, 'rig:0')).toEqual({});
  });

  it('does not mutate its input', () => {
    const bindings = { 'rig:0': { type: 'cc', channel: 1, number: 25 } as MidiTrigger };
    assignBinding(bindings, 'tunerToggle', { type: 'cc', channel: 1, number: 25 });
    clearBinding(bindings, 'rig:0');
    expect(bindings).toEqual({ 'rig:0': { type: 'cc', channel: 1, number: 25 } });
  });
});

describe('clearBindings', () => {
  const trigger = (number: number): MidiTrigger => ({ type: 'cc', channel: 1, number });
  const bindings: Record<string, MidiTrigger> = {
    rigPrev: trigger(20),
    rigNext: trigger(21),
    'rig:0': trigger(22),
    scenePrev: trigger(23),
    'scene:0': trigger(24),
    tunerToggle: trigger(25),
  };

  it('drops only the listed actions', () => {
    expect(clearBindings(bindings, ['rigPrev', 'rigNext', 'rig:0'])).toEqual({
      scenePrev: trigger(23),
      'scene:0': trigger(24),
      tunerToggle: trigger(25),
    });
  });

  it('ignores actions that are not bound', () => {
    expect(clearBindings({ 'rig:0': trigger(22) }, ['rig:0', 'rig:1'])).toEqual({});
    expect(clearBindings({}, ['rig:0'])).toEqual({});
  });

  it('does not mutate its input', () => {
    const before = { ...bindings };
    clearBindings(bindings, ['rigPrev', 'scenePrev']);
    expect(bindings).toEqual(before);
  });
});

describe('stepIndex', () => {
  it('steps forward and backward with wrap-around', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, -1)).toBe(1);
  });

  it('starts from the ends when nothing is active', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
  });

  it('handles empty and single-item lists', () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, -1)).toBe(0);
  });
});

describe('isMidiTrigger / sanitizeTrigger', () => {
  it('accepts well-formed triggers of every kind', () => {
    expect(isMidiTrigger({ type: 'cc', channel: 1, number: 0 })).toBe(true);
    expect(isMidiTrigger({ type: 'pc', channel: 16, number: 127 })).toBe(true);
    expect(isMidiTrigger({ type: 'note', channel: 10, number: 60 })).toBe(true);
  });

  it('rejects out-of-range and malformed values', () => {
    expect(isMidiTrigger({ type: 'cc', channel: 0, number: 5 })).toBe(false);
    expect(isMidiTrigger({ type: 'cc', channel: 17, number: 5 })).toBe(false);
    expect(isMidiTrigger({ type: 'cc', channel: 1, number: -1 })).toBe(false);
    expect(isMidiTrigger({ type: 'cc', channel: 1, number: 128 })).toBe(false);
    expect(isMidiTrigger({ type: 'cc', channel: 1.5, number: 5 })).toBe(false);
    expect(isMidiTrigger({ type: 'aftertouch', channel: 1, number: 5 })).toBe(false);
    expect(isMidiTrigger('cc25')).toBe(false);
    expect(isMidiTrigger(null)).toBe(false);
    expect(isMidiTrigger([1, 2, 3])).toBe(false);
  });

  it('sanitize rebuilds field by field and strips extras; malformed becomes undefined', () => {
    expect(sanitizeTrigger({ type: 'cc', channel: 1, number: 25, value: 127, label: 'x' })).toEqual(
      {
        type: 'cc',
        channel: 1,
        number: 25,
      },
    );
    expect(sanitizeTrigger({ type: 'cc', channel: 99, number: 25 })).toBeUndefined();
    expect(sanitizeTrigger(undefined)).toBeUndefined();
  });
});

describe('triggerOf / triggersEqual / describeTrigger', () => {
  it('strips the value from an event to form its identity', () => {
    expect(triggerOf(cc(25, 127))).toEqual({ type: 'cc', channel: 1, number: 25 });
    expect(triggersEqual(triggerOf(cc(25, 127)), triggerOf(cc(25, 0)))).toBe(true);
  });

  it('formats each trigger kind for the dialog chips', () => {
    expect(describeTrigger({ type: 'cc', channel: 1, number: 25 })).toBe('CC 25 · ch 1');
    expect(describeTrigger({ type: 'pc', channel: 1, number: 5 })).toBe('PC 5 · ch 1');
    // Middle C = C3 convention: note 60 is C3, note 61 is C#3.
    expect(describeTrigger({ type: 'note', channel: 10, number: 61 })).toBe('Note C#3 · ch 10');
    expect(describeTrigger({ type: 'note', channel: 1, number: 0 })).toBe('Note C-2 · ch 1');
  });
});
