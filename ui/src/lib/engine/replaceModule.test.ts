import { beforeEach, describe, expect, it } from 'vitest';
import type { RackModule, RoutingState } from './types';

/** MockEngine persists to localStorage and reads a few browser globals on
    construction. The suite runs in node, so stand those up here rather than
    pulling in a DOM emulator — the same shim rigIdentity.test.ts uses. */
const store = new Map<string, string>();
const globals = globalThis as unknown as Record<string, unknown>;
globals.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
globals.window = { setInterval: () => 0 };
globals.location = { search: '' };

const { MockEngine } = await import('./MockEngine');

describe('replaceModule', () => {
  let engine: InstanceType<typeof MockEngine>;
  let rack: RackModule[] = [];
  let routing: RoutingState = { groups: [] };
  let stop: () => void = () => {};

  beforeEach(() => {
    store.clear();
    engine = new MockEngine();
    rack = [];
    const stopRack = engine.subscribeRack((next) => (rack = next));
    const stopRouting = engine.subscribeRouting((next) => (routing = next));
    stop = () => {
      stopRack();
      stopRouting();
    };
  });

  it('swaps the plugin in place, keeping every other module where it was', () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    engine.insertModule('Mock Drive', { serialPosition: 1 });
    engine.insertModule('Mock Reverb', { serialPosition: 2 });
    const replacedId = rack[1].id;

    engine.replaceModule(replacedId, 'Mock Utility');
    stop();

    expect(rack.map((m) => m.name)).toEqual(['Mock Amp', 'Mock Utility', 'Mock Reverb']);
    // A different plugin means a different set of parameters, so the old
    // module's identity does not survive its plugin.
    expect(rack[1].id).not.toBe(replacedId);
  });

  it('dials the replacement in from the dropped patch, look and all', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    engine.renameModule(rack[0].id, 'JTM45');
    engine.setModuleStyle(rack[0].id, { color: '#ff8800' });
    const patchId = await engine.savePatch(rack[0].id, 'JTM45');

    engine.insertModule('Mock Drive', { serialPosition: 1 });
    engine.replaceModule(rack[1].id, 'Mock Amp', patchId!);
    stop();

    // Exactly what dropping the same tile into a gap produces.
    expect(rack[1]).toMatchObject({ name: 'Mock Amp', displayName: 'JTM45', color: '#ff8800' });
  });

  it('replaces a lane’s only module without collapsing the lane or the split', () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    engine.insertModule('Mock Drive', { serialPosition: 1 });
    engine.createSplit(rack[1].id);
    const laneId = rack[1].laneId;
    expect(laneId).toBeTruthy();
    const lanesBefore = routing.groups[0].lanes.length;

    // The regression this ordering exists for: a remove followed by an insert
    // would empty the lane in between, and an emptied lane takes its split
    // down with it.
    engine.replaceModule(rack[1].id, 'Mock Reverb');
    stop();

    expect(routing.groups).toHaveLength(1);
    expect(routing.groups[0].lanes).toHaveLength(lanesBefore);
    expect(rack[1]).toMatchObject({ name: 'Mock Reverb', laneId });
  });

  it('leaves split positions alone', () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    engine.insertModule('Mock Drive', { serialPosition: 1 });
    engine.insertModule('Mock Reverb', { serialPosition: 2 });
    engine.createSplit(rack[2].id);
    const positions = routing.groups.map((g) => g.position);

    // The module before the split, and the one inside a lane after it.
    engine.replaceModule(rack[0].id, 'Mock Utility');
    engine.replaceModule(rack[2].id, 'Mock Utility');
    stop();

    expect(routing.groups.map((g) => g.position)).toEqual(positions);
  });

  it('ignores a module that is no longer there', () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    engine.replaceModule('mod_gone', 'Mock Drive');
    stop();

    expect(rack.map((m) => m.name)).toEqual(['Mock Amp']);
  });
});
