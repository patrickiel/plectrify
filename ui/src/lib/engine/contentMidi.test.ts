import { describe, expect, it } from 'vitest';
import {
  buildContentTargets,
  findContentBindings,
  knobMeterPatch,
  resolveContentMidi,
  triggerKey,
} from './contentMidi';
import { matchMidi } from './midi';
import { storedFromModule } from './patches';
import type { MidiEvent, MidiTrigger, RackModule, RoutingState } from './types';

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
const trig = (type: MidiTrigger['type'], number: number, channel = 1): MidiTrigger => ({
  type,
  channel,
  number,
});

function makeModule(overrides: Partial<RackModule>): RackModule {
  return {
    id: 'mod-1',
    name: 'Mock Amp',
    bypassed: false,
    params: [],
    availableParams: [],
    ...overrides,
  };
}

const NO_ROUTING: RoutingState = { groups: [] };

describe('buildContentTargets', () => {
  it('maps bound knobs, modules and lanes under their trigger keys', () => {
    const rack = [
      makeModule({
        id: 'mod-1',
        midi: trig('note', 40),
        params: [
          { knobId: 'k1', paramIndex: 3, label: 'Gain', value: 0.5, midi: trig('cc', 11) },
          {
            knobId: 'k2',
            paramIndex: 7,
            label: 'Boost',
            value: 0,
            isBoolean: true,
            midi: trig('cc', 12),
          },
        ],
      }),
    ];
    const routing: RoutingState = {
      groups: [
        {
          id: 'g1',
          position: 0,
          lanes: [
            {
              id: 'l1',
              name: 'A',
              gain: 1,
              pan: 0,
              muted: false,
              soloed: false,
              midi: trig('pc', 5),
            },
          ],
        },
      ],
    };
    const targets = buildContentTargets(rack, routing);
    expect(targets.get('cc:1:11')).toEqual({
      kind: 'knob',
      moduleId: 'mod-1',
      paramIndex: 3,
      isBoolean: false,
    });
    expect(targets.get('cc:1:12')).toEqual({
      kind: 'knob',
      moduleId: 'mod-1',
      paramIndex: 7,
      isBoolean: true,
    });
    expect(targets.get('note:1:40')).toEqual({ kind: 'module', moduleId: 'mod-1' });
    expect(targets.get('pc:1:5')).toEqual({ kind: 'lane', groupId: 'g1', laneId: 'l1' });
    expect(targets.size).toBe(4);
  });

  it('excludes meters even when a stale binding sits on one, and unbound entries', () => {
    const rack = [
      makeModule({
        params: [
          {
            knobId: 'k1',
            paramIndex: 3,
            label: 'Out',
            value: 0.5,
            isMeter: true,
            midi: trig('cc', 11),
          },
          { knobId: 'k2', paramIndex: 4, label: 'Tone', value: 0.5 },
        ],
      }),
    ];
    expect(buildContentTargets(rack, NO_ROUTING).size).toBe(0);
  });

  it('resolves duplicate triggers to the first owner deterministically', () => {
    const rack = [
      makeModule({
        id: 'mod-1',
        params: [{ knobId: 'k1', paramIndex: 1, label: 'A', value: 0, midi: trig('cc', 11) }],
      }),
      makeModule({
        id: 'mod-2',
        params: [{ knobId: 'k2', paramIndex: 2, label: 'B', value: 0, midi: trig('cc', 11) }],
      }),
    ];
    const targets = buildContentTargets(rack, NO_ROUTING);
    expect(targets.get('cc:1:11')).toMatchObject({ moduleId: 'mod-1' });
  });
});

describe('resolveContentMidi', () => {
  const targets = buildContentTargets(
    [
      makeModule({
        id: 'mod-1',
        midi: trig('cc', 30),
        params: [
          { knobId: 'k1', paramIndex: 3, label: 'Gain', value: 0.5, midi: trig('cc', 11) },
          {
            knobId: 'k2',
            paramIndex: 7,
            label: 'Boost',
            value: 0,
            isBoolean: true,
            midi: trig('cc', 12),
          },
          {
            knobId: 'k3',
            paramIndex: 8,
            label: 'Solo',
            value: 0,
            isBoolean: true,
            midi: trig('note', 60),
          },
        ],
      }),
    ],
    {
      groups: [
        {
          id: 'g1',
          position: 0,
          lanes: [
            {
              id: 'l1',
              name: 'A',
              gain: 1,
              pan: 0,
              muted: false,
              soloed: false,
              midi: trig('cc', 40),
            },
          ],
        },
      ],
    },
  );

  it('tracks a continuous knob on every CC value, including below the press threshold', () => {
    expect(resolveContentMidi(targets, cc(11, 0))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 3,
      value: 0,
    });
    expect(resolveContentMidi(targets, cc(11, 10))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 3,
      value: 10 / 127,
    });
    expect(resolveContentMidi(targets, cc(11, 127))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 3,
      value: 1,
    });
  });

  it('maps a boolean knob CC to switch position and note presses to toggles', () => {
    expect(resolveContentMidi(targets, cc(12, 127))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 7,
      value: 1,
    });
    expect(resolveContentMidi(targets, cc(12, 64))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 7,
      value: 1,
    });
    expect(resolveContentMidi(targets, cc(12, 63))).toEqual({
      kind: 'setParam',
      moduleId: 'mod-1',
      paramIndex: 7,
      value: 0,
    });
    expect(resolveContentMidi(targets, note(60))).toEqual({
      kind: 'toggleParam',
      moduleId: 'mod-1',
      paramIndex: 8,
    });
  });

  it('toggles module bypass on presses only', () => {
    expect(resolveContentMidi(targets, cc(30, 127))).toEqual({
      kind: 'toggleBypass',
      moduleId: 'mod-1',
    });
    expect(resolveContentMidi(targets, cc(30, 0))).toBeNull();
  });

  it('switches lanes on presses only', () => {
    expect(resolveContentMidi(targets, cc(40, 127))).toEqual({
      kind: 'laneSwitch',
      groupId: 'g1',
      laneId: 'l1',
    });
    expect(resolveContentMidi(targets, cc(40, 20))).toBeNull();
  });

  it('returns null for unmapped triggers and wrong message kinds', () => {
    expect(resolveContentMidi(targets, cc(99, 127))).toBeNull();
    // A note aimed at a continuous knob is only reachable from a hand-edited
    // file; it must do nothing rather than jump the parameter.
    const handEdited = buildContentTargets(
      [
        makeModule({
          params: [{ knobId: 'k1', paramIndex: 3, label: 'G', value: 0, midi: trig('note', 61) }],
        }),
      ],
      NO_ROUTING,
    );
    expect(resolveContentMidi(handEdited, note(61))).toBeNull();
  });
});

describe('content-first precedence contract', () => {
  it('a trigger owned by content must be consumed even on a release, never reaching global actions', () => {
    const rack = [makeModule({ midi: trig('cc', 25) })];
    const targets = buildContentTargets(rack, NO_ROUTING);
    const globalBindings = { rigNext: trig('cc', 25) };

    // The dispatcher's rule: check the key first, and never consult the
    // global table when it is present — even for the release, which
    // resolves to no content command.
    const release = cc(25, 0);
    expect(targets.has(triggerKey({ type: 'cc', channel: 1, number: 25 }))).toBe(true);
    expect(resolveContentMidi(targets, release)).toBeNull();
    // Without the consume rule this release would be ignored by matchMidi
    // anyway — but the press would double-fire, which this guards:
    expect(matchMidi(globalBindings, cc(25, 127))).toBe('rigNext');
  });
});

describe('findContentBindings', () => {
  it('returns every owner of a trigger across knobs, modules and lanes', () => {
    const shared = trig('cc', 20);
    const rack = [
      makeModule({
        id: 'mod-1',
        midi: shared,
        params: [{ knobId: 'k1', paramIndex: 1, label: 'A', value: 0, midi: shared }],
      }),
    ];
    const routing: RoutingState = {
      groups: [
        {
          id: 'g1',
          position: 0,
          lanes: [
            { id: 'l1', name: 'A', gain: 1, pan: 0, muted: false, soloed: false, midi: shared },
          ],
        },
      ],
    };
    expect(findContentBindings(rack, routing, shared)).toEqual([
      { kind: 'module', moduleId: 'mod-1' },
      { kind: 'knob', moduleId: 'mod-1', knobId: 'k1' },
      { kind: 'lane', laneId: 'l1' },
    ]);
    expect(findContentBindings(rack, routing, trig('cc', 21))).toEqual([]);
  });
});

describe('knobMeterPatch', () => {
  const bound = { knobId: 'k1', paramIndex: 3, label: 'Out', value: 0.5, midi: trig('cc', 11) };

  it('clears the binding on meter-enable and does not restore it on convert-back', () => {
    const meter = { ...bound, ...knobMeterPatch(true) };
    expect(meter.isMeter).toBe(true);
    expect(meter.midi).toBeUndefined();

    const back = { ...meter, ...knobMeterPatch(false) };
    expect(back.isMeter).toBe(false);
    expect(back.midi).toBeUndefined();
  });

  it('leaves an existing binding alone when only disabling the meter', () => {
    // A stale bound-meter can exist via hand-edited files; disabling the
    // meter is not the moment to silently drop what the user wrote.
    expect({ ...bound, ...knobMeterPatch(false) }.midi).toEqual(trig('cc', 11));
  });
});

describe('patches never carry MIDI bindings', () => {
  it('storedFromModule drops the midi field from a bound knob', () => {
    const module = makeModule({
      params: [{ knobId: 'k1', paramIndex: 3, label: 'Gain', value: 0.5, midi: trig('cc', 11) }],
    });
    const patch = storedFromModule(module, 'My patch');
    expect(patch.knobs).toHaveLength(1);
    expect('midi' in patch.knobs[0]).toBe(false);
  });
});
