import { describe, expect, it, vi } from 'vitest';
import {
  captureScene,
  isSceneArray,
  reconcileScenes,
  remapSceneIds,
  sceneMatchesLive,
} from './scenes';
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

const routing: RoutingState = {
  groups: [
    {
      id: 'g1',
      position: 0,
      activeLaneId: 'l1',
      lanes: [
        { id: 'l1', name: 'A', gain: 1, pan: 0, muted: false, soloed: false },
        { id: 'l2', name: 'B', gain: 0.5, pan: -1, muted: true, soloed: false },
      ],
    },
  ],
};

const noRouting: RoutingState = { groups: [] };

describe('captureScene', () => {
  it('captures mapped values, bypass, and lane state', () => {
    const scene = captureScene(
      ' Verse ',
      [module({ id: 'm1', bypassed: true, params: [knob({ paramIndex: 3, value: 0.7 })] })],
      routing,
    );
    expect(scene.name).toBe('Verse');
    expect(scene.modules).toEqual([
      { moduleId: 'm1', bypassed: true, params: [{ paramIndex: 3, value: 0.7 }] },
    ]);
    expect(scene.lanes).toEqual([
      { laneId: 'l1', gain: 1, pan: 0, muted: false, soloed: false },
      { laneId: 'l2', gain: 0.5, pan: -1, muted: true, soloed: false },
    ]);
    expect(scene.switches).toEqual([{ groupId: 'g1', activeLaneId: 'l1' }]);
  });

  it('skips meter knobs and de-dupes doubly-mapped params', () => {
    const scene = captureScene(
      '',
      [
        module({
          id: 'm1',
          params: [
            knob({ paramIndex: 1, value: 0.2 }),
            knob({ knobId: 'k1b', paramIndex: 1, value: 0.9 }),
            knob({ paramIndex: 5, value: 0.4, isMeter: true }),
          ],
        }),
      ],
      noRouting,
    );
    expect(scene.name).toBe('Scene');
    expect(scene.modules[0].params).toEqual([{ paramIndex: 1, value: 0.2 }]);
  });
});

describe('sceneMatchesLive', () => {
  const rack = [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5 })] })];
  const scene = captureScene('S', rack, routing);

  it('matches an unchanged rack, tolerating epsilon-scale drift', () => {
    expect(sceneMatchesLive(scene, rack, routing)).toBe(true);
    const drifted = [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.50000001 })] })];
    expect(sceneMatchesLive(scene, drifted, routing)).toBe(true);
  });

  it('detects param, bypass, lane, and switch drift', () => {
    expect(
      sceneMatchesLive(
        scene,
        [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.6 })] })],
        routing,
      ),
    ).toBe(false);
    expect(sceneMatchesLive(scene, [module({ id: 'm1', bypassed: true })], routing)).toBe(false);

    const laneDrift = structuredClone(routing);
    laneDrift.groups[0].lanes[1].gain = 0.9;
    expect(sceneMatchesLive(scene, rack, laneDrift)).toBe(false);

    const switchDrift = structuredClone(routing);
    switchDrift.groups[0].activeLaneId = undefined;
    expect(sceneMatchesLive(scene, rack, switchDrift)).toBe(false);
  });

  it('ignores modules and lanes the scene never captured', () => {
    const grown = [...rack, module({ id: 'm2', bypassed: true })];
    expect(sceneMatchesLive(scene, grown, routing)).toBe(true);
  });

  it('reports drift when a captured module is gone from the rack', () => {
    expect(sceneMatchesLive(scene, [module({ id: 'other' })], routing)).toBe(false);
    expect(sceneMatchesLive(scene, [], routing)).toBe(false);
  });

  it('reports drift for a scene with no module entries against a non-empty rack', () => {
    const husk: Scene = { ...scene, modules: [] };
    expect(sceneMatchesLive(husk, rack, routing)).toBe(false);
    // Nothing to compare against nothing: an empty rack matches an empty scene.
    expect(sceneMatchesLive(husk, [], routing)).toBe(true);
  });
});

describe('remapSceneIds', () => {
  it('re-keys module entries and drops orphans, warning about the loss', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scene = captureScene('S', [module({ id: 'old1' }), module({ id: 'old2' })], noRouting);
      const [remapped] = remapSceneIds([scene], new Map([['old1', 'new1']]));
      expect(remapped.modules.map((m) => m.moduleId)).toEqual(['new1']);
      // Original untouched.
      expect(scene.modules).toHaveLength(2);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('lost 1 of 2');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when every entry survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scene = captureScene('S', [module({ id: 'old1' })], noRouting);
      remapSceneIds([scene], new Map([['old1', 'new1']]));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('reconcileScenes', () => {
  it('backfills an added module from live state, excluding meters', () => {
    const scene = captureScene('S', [module({ id: 'm1' })], noRouting);
    const grown = [
      module({ id: 'm1' }),
      module({
        id: 'm2',
        bypassed: true,
        params: [
          knob({ paramIndex: 1, value: 0.3 }),
          // Doubly-mapped knobs mirror the same plugin parameter, so they
          // always carry the same live value.
          knob({ knobId: 'k1b', paramIndex: 1, value: 0.3 }),
          knob({ paramIndex: 5, value: 0.4, isMeter: true }),
        ],
      }),
    ];
    const { scenes, changed } = reconcileScenes([scene], grown, noRouting);
    expect(changed).toBe(true);
    expect(scenes[0].modules).toEqual([
      { moduleId: 'm1', bypassed: false, params: [] },
      { moduleId: 'm2', bypassed: true, params: [{ paramIndex: 1, value: 0.3 }] },
    ]);
    expect(sceneMatchesLive(scenes[0], grown, noRouting)).toBe(true);
  });

  it('prunes a removed module, leaving other entries untouched', () => {
    const rack = [
      module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5 })] }),
      module({ id: 'm2' }),
    ];
    const scene = captureScene('S', rack, noRouting);
    const { scenes, changed } = reconcileScenes([scene], [rack[0]], noRouting);
    expect(changed).toBe(true);
    expect(scenes[0].modules).toHaveLength(1);
    // The surviving entry is the same object, not a rebuilt copy.
    expect(scenes[0].modules[0]).toBe(scene.modules[0]);
  });

  it('backfills a newly mapped knob without clobbering stored values', () => {
    const scene = captureScene(
      'S',
      [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5 })] })],
      noRouting,
    );
    const live = [
      module({
        id: 'm1',
        params: [knob({ paramIndex: 0, value: 0.9 }), knob({ paramIndex: 2, value: 0.7 })],
      }),
    ];
    const { scenes } = reconcileScenes([scene], live, noRouting);
    expect(scenes[0].modules[0].params).toEqual([
      { paramIndex: 0, value: 0.5 }, // stored value preserved, not the live 0.9
      { paramIndex: 2, value: 0.7 },
    ]);
  });

  it('prunes an unmapped param, but keeps it while any non-meter knob still maps it', () => {
    const doubly = [
      module({
        id: 'm1',
        params: [
          knob({ paramIndex: 0, value: 0.5 }),
          knob({ knobId: 'kb', paramIndex: 0, value: 0.5 }),
        ],
      }),
    ];
    const scene = captureScene('S', doubly, noRouting);

    const oneLeft = [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5 })] })];
    expect(reconcileScenes([scene], oneLeft, noRouting).changed).toBe(false);

    const meterOnly = [
      module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5, isMeter: true })] }),
    ];
    const pruned = reconcileScenes([scene], meterOnly, noRouting);
    expect(pruned.changed).toBe(true);
    expect(pruned.scenes[0].modules[0].params).toEqual([]);
  });

  it('backfills and prunes lanes and switches, re-seeding a switch whose lane is gone', () => {
    const rack = [module({ id: 'm1' })];
    const scene = captureScene('S', rack, routing); // knows l1, l2, g1 (active l1)

    const laneGone = structuredClone(routing);
    laneGone.groups[0].lanes.splice(0, 1); // remove l1 — the scene's active lane
    laneGone.groups[0].activeLaneId = 'l2';
    const { scenes, changed } = reconcileScenes([scene], rack, laneGone);
    expect(changed).toBe(true);
    expect(scenes[0].lanes.map((l) => l.laneId)).toEqual(['l2']);
    expect(scenes[0].switches).toEqual([{ groupId: 'g1', activeLaneId: 'l2' }]);

    const laneAdded = structuredClone(routing);
    laneAdded.groups[0].lanes.push({
      id: 'l3',
      name: 'C',
      gain: 0.8,
      pan: 1,
      muted: false,
      soloed: true,
    });
    laneAdded.groups.push({ id: 'g2', position: 1, activeLaneId: undefined, lanes: [] });
    const grownResult = reconcileScenes([scene], rack, laneAdded);
    expect(grownResult.scenes[0].lanes).toContainEqual({
      laneId: 'l3',
      gain: 0.8,
      pan: 1,
      muted: false,
      soloed: true,
    });
    expect(grownResult.scenes[0].switches).toContainEqual({
      groupId: 'g2',
      activeLaneId: undefined,
    });
  });

  it('is a stable no-op on an unchanged rack, and idempotent', () => {
    const rack = [module({ id: 'm1', params: [knob({ paramIndex: 0, value: 0.5 })] })];
    const scenes = [captureScene('S', rack, routing)];
    const first = reconcileScenes(scenes, rack, routing);
    expect(first.changed).toBe(false);
    expect(first.scenes).toBe(scenes);

    const grown = [...rack, module({ id: 'm2' })];
    const once = reconcileScenes(scenes, grown, routing);
    const twice = reconcileScenes(once.scenes, grown, routing);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.scenes).toBe(once.scenes);
  });

  it('defers param backfill until hasKnownValue reports the value streamed', () => {
    const scene = captureScene('S', [module({ id: 'm1' })], noRouting);
    const live = [module({ id: 'm1', params: [knob({ paramIndex: 3, value: 0.5 })] })];

    const gated = reconcileScenes([scene], live, noRouting, { hasKnownValue: () => false });
    expect(gated.changed).toBe(false);

    const streamed = [module({ id: 'm1', params: [knob({ paramIndex: 3, value: 0.42 })] })];
    const done = reconcileScenes([scene], streamed, noRouting, { hasKnownValue: () => true });
    expect(done.changed).toBe(true);
    expect(done.scenes[0].modules[0].params).toEqual([{ paramIndex: 3, value: 0.42 }]);
  });

  it('reconciles multiple scenes independently', () => {
    const rack = [module({ id: 'm1' })];
    const untouched = captureScene('A', rack, noRouting);
    const stale: Scene = { ...captureScene('B', rack, noRouting), modules: [] };
    const { scenes } = reconcileScenes([untouched, stale], rack, noRouting);
    expect(scenes[0]).toBe(untouched);
    expect(scenes[1].modules.map((m) => m.moduleId)).toEqual(['m1']);
  });

  it('round-trips a fresh capture unchanged', () => {
    const rack = [
      module({ id: 'm1', bypassed: true, params: [knob({ paramIndex: 0, value: 0.5 })] }),
    ];
    expect(reconcileScenes([captureScene('S', rack, routing)], rack, routing).changed).toBe(false);
  });
});

describe('isSceneArray', () => {
  const valid: Scene = {
    id: 's1',
    name: 'Verse',
    modules: [{ moduleId: 'm1', bypassed: false, params: [{ paramIndex: 0, value: 0.5 }] }],
    lanes: [{ laneId: 'l1', gain: 1, pan: 0, muted: false, soloed: false }],
    switches: [{ groupId: 'g1', activeLaneId: 'l1' }, { groupId: 'g2' }],
  };

  it('accepts well-formed scenes and rejects malformed data', () => {
    expect(isSceneArray([])).toBe(true);
    expect(isSceneArray([valid])).toBe(true);
    expect(isSceneArray(null)).toBe(false);
    expect(isSceneArray([{ ...valid, modules: [{ moduleId: 1 }] }])).toBe(false);
    expect(isSceneArray([{ ...valid, lanes: [{ laneId: 'l1' }] }])).toBe(false);
  });
});
