import { describe, expect, it } from 'vitest';
import { canRevertViaScene, rigSignature } from './rigSignature';
import type { MappedParam, RackModule, RoutingState, Scene } from './types';

const knob = (over: Partial<MappedParam> & { paramIndex: number; value: number }): MappedParam => ({
  knobId: `k${over.paramIndex}`,
  label: 'Knob',
  ...over,
});

const module = (over: Partial<RackModule> & { id: string }): RackModule => ({
  name: 'Amp',
  bypassed: false,
  params: [],
  availableParams: [],
  ...over,
});

const routing = (over?: Partial<RoutingState['groups'][number]>): RoutingState => ({
  groups: [
    {
      id: 'g1',
      position: 0,
      activeLaneId: 'l1',
      lanes: [
        { id: 'l1', name: 'A', gain: 1, pan: 0, muted: false, soloed: false },
        { id: 'l2', name: 'B', gain: 0.5, pan: -1, muted: true, soloed: false },
      ],
      ...over,
    },
  ],
});

const scene = (over?: Partial<Scene>): Scene => ({
  id: 's1',
  name: 'Verse',
  modules: [{ moduleId: 'm1', bypassed: false, params: [{ paramIndex: 0, value: 0.7 }] }],
  lanes: [{ laneId: 'l1', gain: 1, pan: 0, muted: false, soloed: false }],
  switches: [{ groupId: 'g1', activeLaneId: 'l1' }],
  ...over,
});

const rack = (params: MappedParam[] = [knob({ paramIndex: 0, value: 0.7 })]): RackModule[] => [
  module({ id: 'm1', params }),
];

describe('rigSignature echo tolerance', () => {
  it('is stable across identical states', () => {
    expect(rigSignature(rack(), routing(), [scene()])).toBe(
      rigSignature(rack(), routing(), [scene()]),
    );
  });

  it('ignores knob text, including absent vs present', () => {
    const optimistic = rack([knob({ paramIndex: 0, value: 0.7, text: '-12.9 dB' })]);
    const echoed = rack([knob({ paramIndex: 0, value: 0.7, text: '-13.0 dB' })]);
    const bare = rack([knob({ paramIndex: 0, value: 0.7 })]);
    expect(rigSignature(optimistic, routing(), [])).toBe(rigSignature(echoed, routing(), []));
    expect(rigSignature(optimistic, routing(), [])).toBe(rigSignature(bare, routing(), []));
  });

  it('absorbs float32 round-trips on knob values, lane mix, and scene values', () => {
    const exact = 0.573451220989227;
    const f32 = Math.fround(exact);
    expect(rigSignature(rack([knob({ paramIndex: 0, value: exact })]), routing(), [])).toBe(
      rigSignature(rack([knob({ paramIndex: 0, value: f32 })]), routing(), []),
    );

    const lanes = (gain: number): RoutingState => ({
      groups: [
        {
          ...routing().groups[0],
          lanes: [{ id: 'l1', name: 'A', gain, pan: 0, muted: false, soloed: false }],
        },
      ],
    });
    expect(rigSignature(rack(), lanes(exact), [])).toBe(rigSignature(rack(), lanes(f32), []));

    const sceneWith = (value: number) =>
      scene({ modules: [{ moduleId: 'm1', bypassed: false, params: [{ paramIndex: 0, value }] }] });
    expect(rigSignature(rack(), routing(), [sceneWith(exact)])).toBe(
      rigSignature(rack(), routing(), [sceneWith(f32)]),
    );
  });

  it('does not absorb a round-trip that straddles a grid boundary', () => {
    // The documented limit of quantisation: values differing by far less than
    // SCENE_VALUE_EPSILON still differ when they sit either side of a bucket
    // boundary (an odd multiple of the epsilon / 2). `sceneMatchesLive` would
    // call these equal. Pinned so the tolerance is not mistaken for an epsilon
    // compare — no bucketing can be one.
    const onBoundary = 0.50005;
    const justUnder = onBoundary - 1e-9;
    expect(
      rigSignature(rack([knob({ paramIndex: 0, value: onBoundary })]), routing(), []),
    ).not.toBe(rigSignature(rack([knob({ paramIndex: 0, value: justUnder })]), routing(), []));
  });

  it('ignores engine parameter metadata and plugin identity fields', () => {
    const withMeta = [
      module({
        id: 'm1',
        pluginVersion: '1.0.1',
        pluginManufacturer: 'Vendor',
        availableParams: [{ index: 0, name: 'Gain', defaultValue: 0.5 }],
        params: [knob({ paramIndex: 0, value: 0.7, valueStrings: ['Off', 'On'], isBoolean: true })],
      }),
    ];
    const standby = rack([knob({ paramIndex: 0, value: 0.7 })]);
    expect(rigSignature(withMeta, routing(), [])).toBe(rigSignature(standby, routing(), []));
  });

  it('ignores a meter knob’s live value', () => {
    const at = (value: number) => rack([knob({ paramIndex: 2, value, isMeter: true })]);
    expect(rigSignature(at(0.1), routing(), [])).toBe(rigSignature(at(0.9), routing(), []));
  });
});

describe('rigSignature real edits', () => {
  const base = () => rigSignature(rack(), routing(), [scene()]);

  it('changes when a value moves beyond epsilon', () => {
    expect(
      rigSignature(rack([knob({ paramIndex: 0, value: 0.75 })]), routing(), [scene()]),
    ).not.toBe(base());
  });

  it('changes on bypass, mapping, and module metadata edits', () => {
    expect(
      rigSignature([module({ id: 'm1', bypassed: true, params: rack()[0].params })], routing(), [
        scene(),
      ]),
    ).not.toBe(base());
    expect(rigSignature(rack([]), routing(), [scene()])).not.toBe(base());
    expect(
      rigSignature(rack([knob({ paramIndex: 0, value: 0.7, label: 'Drive' })]), routing(), [
        scene(),
      ]),
    ).not.toBe(base());
    expect(
      rigSignature(rack([knob({ paramIndex: 0, value: 0.7, pos: 3 })]), routing(), [scene()]),
    ).not.toBe(base());
    expect(
      rigSignature(
        rack([knob({ paramIndex: 0, value: 0.7, midi: { type: 'cc', channel: 1, number: 20 } })]),
        routing(),
        [scene()],
      ),
    ).not.toBe(base());
    expect(
      rigSignature(
        [module({ id: 'm1', displayName: 'Lead', params: rack()[0].params })],
        routing(),
        [scene()],
      ),
    ).not.toBe(base());
    expect(
      rigSignature([module({ id: 'm1', color: '#ff0000', params: rack()[0].params })], routing(), [
        scene(),
      ]),
    ).not.toBe(base());
    expect(
      rigSignature([module({ id: 'm1', laneId: 'l1', params: rack()[0].params })], routing(), [
        scene(),
      ]),
    ).not.toBe(base());
  });

  it('changes on style variant, icon, and texture edits', () => {
    // Each of the three appearance fields must dirty the rig on its own, or a
    // style-only edit would be silently lost on close.
    for (const look of [
      { styleVariant: 'bold' as const },
      { icon: 'amp' as const },
      { texture: 'tolex' as const },
    ]) {
      expect(
        rigSignature([module({ id: 'm1', ...look, params: rack()[0].params })], routing(), [
          scene(),
        ]),
      ).not.toBe(base());
    }
  });

  it('changes on module add, remove, and reorder', () => {
    const two = [...rack(), module({ id: 'm2' })];
    expect(rigSignature(two, routing(), [scene()])).not.toBe(base());
    expect(rigSignature([], routing(), [scene()])).not.toBe(base());
    expect(rigSignature([...two].reverse(), routing(), [scene()])).not.toBe(
      rigSignature(two, routing(), [scene()]),
    );
  });

  it('changes on lane and switch edits', () => {
    const gainUp = routing();
    gainUp.groups[0].lanes[0].gain = 0.8;
    expect(rigSignature(rack(), gainUp, [scene()])).not.toBe(base());

    const muted = routing();
    muted.groups[0].lanes[0].muted = true;
    expect(rigSignature(rack(), muted, [scene()])).not.toBe(base());

    const renamed = routing();
    renamed.groups[0].lanes[0].name = 'Clean';
    expect(rigSignature(rack(), renamed, [scene()])).not.toBe(base());

    expect(rigSignature(rack(), routing({ activeLaneId: 'l2' }), [scene()])).not.toBe(base());
  });

  it('changes on scene rename, value edits, and entry backfill', () => {
    expect(rigSignature(rack(), routing(), [scene({ name: 'Chorus' })])).not.toBe(base());
    expect(
      rigSignature(rack(), routing(), [
        scene({
          modules: [{ moduleId: 'm1', bypassed: false, params: [{ paramIndex: 0, value: 0.3 }] }],
        }),
      ]),
    ).not.toBe(base());
    // A backfilled entry is new persistable content, so it counts as an edit.
    expect(
      rigSignature(rack(), routing(), [
        scene({
          modules: [
            {
              moduleId: 'm1',
              bypassed: false,
              params: [
                { paramIndex: 0, value: 0.7 },
                { paramIndex: 4, value: 0.5 },
              ],
            },
          ],
        }),
      ]),
    ).not.toBe(base());
  });
});

describe('canRevertViaScene', () => {
  // The shared scene fixture stores only lane l1; the discard check demands
  // coverage of every baseline lane, so these tests use a scene mirroring the
  // full routing fixture (l1 + l2).
  const fullScene = (over?: Partial<Scene>): Scene =>
    scene({
      lanes: [
        { laneId: 'l1', gain: 1, pan: 0, muted: false, soloed: false },
        { laneId: 'l2', gain: 0.5, pan: -1, muted: true, soloed: false },
      ],
      ...over,
    });

  const baseline = (s: Scene = fullScene()) => rigSignature(rack(), routing(), [s]);

  it('accepts knob value drift the scene stores the baseline value for', () => {
    const current = rigSignature(rack([knob({ paramIndex: 0, value: 0.4 })]), routing(), [
      fullScene(),
    ]);
    expect(canRevertViaScene(baseline(), current, fullScene())).toBe(true);
  });

  it('accepts bypass drift', () => {
    const current = rigSignature(
      [module({ id: 'm1', bypassed: true, params: rack()[0].params })],
      routing(),
      [fullScene()],
    );
    expect(canRevertViaScene(baseline(), current, fullScene())).toBe(true);
  });

  it('accepts lane mix and switch drift', () => {
    const gainUp = routing();
    gainUp.groups[0].lanes[0].gain = 0.8;
    expect(
      canRevertViaScene(baseline(), rigSignature(rack(), gainUp, [fullScene()]), fullScene()),
    ).toBe(true);

    const muted = routing();
    muted.groups[0].lanes[0].muted = true;
    expect(
      canRevertViaScene(baseline(), rigSignature(rack(), muted, [fullScene()]), fullScene()),
    ).toBe(true);

    const switched = rigSignature(rack(), routing({ activeLaneId: 'l2' }), [fullScene()]);
    expect(canRevertViaScene(baseline(), switched, fullScene())).toBe(true);
  });

  it('accepts combined value, bypass, and lane drift', () => {
    const drifted = routing({ activeLaneId: 'l2' });
    drifted.groups[0].lanes[1].pan = 0.25;
    const current = rigSignature(
      [module({ id: 'm1', bypassed: true, params: [knob({ paramIndex: 0, value: 0.1 })] })],
      drifted,
      [fullScene()],
    );
    expect(canRevertViaScene(baseline(), current, fullScene())).toBe(true);
  });

  it('rejects module add, remove, and metadata or mapping edits', () => {
    const two = [...rack(), module({ id: 'm2' })];
    expect(
      canRevertViaScene(baseline(), rigSignature(two, routing(), [fullScene()]), fullScene()),
    ).toBe(false);
    expect(
      canRevertViaScene(baseline(), rigSignature([], routing(), [fullScene()]), fullScene()),
    ).toBe(false);
    expect(
      canRevertViaScene(
        baseline(),
        rigSignature(
          [module({ id: 'm1', displayName: 'Lead', params: rack()[0].params })],
          routing(),
          [fullScene()],
        ),
        fullScene(),
      ),
    ).toBe(false);
    // Remapping a knob changes which parameter it writes — structural.
    expect(
      canRevertViaScene(
        baseline(),
        rigSignature(rack([knob({ paramIndex: 1, value: 0.7 })]), routing(), [fullScene()]),
        fullScene(),
      ),
    ).toBe(false);
  });

  it('rejects edits to the stored scenes themselves', () => {
    const renamed = fullScene({ name: 'Chorus' });
    const current = rigSignature(rack([knob({ paramIndex: 0, value: 0.4 })]), routing(), [renamed]);
    expect(canRevertViaScene(baseline(), current, renamed)).toBe(false);
  });

  it('rejects a scene that does not cover a drifted or tracked field', () => {
    // Scene entry lacks the param the baseline tracks (hasKnownValue backfill gap).
    const uncovered = fullScene({ modules: [{ moduleId: 'm1', bypassed: false, params: [] }] });
    const current = rigSignature(rack([knob({ paramIndex: 0, value: 0.4 })]), routing(), [
      uncovered,
    ]);
    expect(canRevertViaScene(baseline(uncovered), current, uncovered)).toBe(false);

    // Scene lacks lane l2, which the baseline tracks.
    const partial = scene();
    const drifted = rigSignature(rack([knob({ paramIndex: 0, value: 0.4 })]), routing(), [partial]);
    expect(canRevertViaScene(baseline(partial), drifted, partial)).toBe(false);
  });

  it('rejects a scene whose stored values differ from the baseline', () => {
    const stale = fullScene({
      modules: [{ moduleId: 'm1', bypassed: false, params: [{ paramIndex: 0, value: 0.3 }] }],
    });
    const current = rigSignature(rack([knob({ paramIndex: 0, value: 0.4 })]), routing(), [stale]);
    expect(canRevertViaScene(baseline(stale), current, stale)).toBe(false);

    const wrongSwitch = fullScene({ switches: [{ groupId: 'g1', activeLaneId: 'l2' }] });
    const drifted = rigSignature(rack(), routing({ activeLaneId: 'l2' }), [wrongSwitch]);
    expect(canRevertViaScene(baseline(wrongSwitch), drifted, wrongSwitch)).toBe(false);
  });

  it('rejects an empty or unparseable baseline', () => {
    const current = rigSignature(rack(), routing(), [fullScene()]);
    expect(canRevertViaScene('', current, fullScene())).toBe(false);
    expect(canRevertViaScene('not json', current, fullScene())).toBe(false);
  });
});
