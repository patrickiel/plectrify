import { beforeEach, describe, expect, it } from 'vitest';
import type { Patch, RackModule, Rig } from './types';

/** MockEngine persists to localStorage and reads a few browser globals on
    construction. The suite runs in node, so stand those up here rather than
    pulling in a DOM emulator for one file — this is the whole surface it
    touches before the first rig call. */
const store = new Map<string, string>();
const globals = globalThis as unknown as Record<string, unknown>;
globals.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
// setInterval is a no-op: the mock's 15 Hz status tick has nothing to do with
// rig storage, and letting it run would keep the process alive.
globals.window = { setInterval: () => 0 };
// No query string, so the tuner demo takes its default sweep.
globals.location = { search: '' };

const { MockEngine } = await import('./MockEngine');

/** The rigs as they sit in storage, including the module lists the public
    `Rig` list deliberately omits. */
function storedRigs(): { id: string; name: string; modules: { name: string }[] }[] {
  return JSON.parse(store.get('plectrify.rigs') ?? '[]');
}

function rigList(engine: InstanceType<typeof MockEngine>): Rig[] {
  let rigs: Rig[] = [];
  engine.subscribeRigs((next) => (rigs = next))();
  return rigs;
}

describe('rig identity', () => {
  let engine: InstanceType<typeof MockEngine>;

  beforeEach(() => {
    store.clear();
    engine = new MockEngine();
  });

  it('saveRig creates a new rig even when the name is already taken', async () => {
    const first = await engine.saveRig('Lead');
    const second = await engine.saveRig('Lead');

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(rigList(engine).map((r) => r.name)).toEqual(['Lead', 'Lead']);
  });

  it('updateRig writes to the id it is given, not the first rig sharing its name', async () => {
    // Rig A: one module. Rig B: two — so a cross-write is visible in the count.
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    const rigA = await engine.saveRig('A');
    engine.insertModule('Mock Drive', { serialPosition: 1 });
    const rigB = await engine.saveRig('B');
    expect(rigA).not.toBeNull();
    expect(rigB).not.toBeNull();

    // The collision the review found: B now displays under A's name.
    engine.renameRig(rigB!, 'A');
    expect(rigList(engine).map((r) => r.name)).toEqual(['A', 'A']);

    // Edit B and save it. Keyed by id, this must not touch rig A.
    engine.insertModule('Mock Reverb', { serialPosition: 2 });
    expect(await engine.updateRig(rigB!)).toBe(true);

    const stored = storedRigs();
    const a = stored.find((r) => r.id === rigA);
    const b = stored.find((r) => r.id === rigB);
    expect(a?.modules.map((m) => m.name)).toEqual(['Mock Amp']);
    expect(b?.modules.map((m) => m.name)).toEqual(['Mock Amp', 'Mock Drive', 'Mock Reverb']);
    // Renaming is metadata only — the update must not have moved or re-added it.
    expect(stored.map((r) => r.id)).toEqual([rigA, rigB]);
  });

  it('updateRig reports failure for an unknown rig instead of creating one', async () => {
    await engine.saveRig('Lead');
    expect(await engine.updateRig('rig_missing')).toBe(false);
    expect(rigList(engine)).toHaveLength(1);
  });
});

describe('patch identity', () => {
  let engine: InstanceType<typeof MockEngine>;

  beforeEach(() => {
    store.clear();
    engine = new MockEngine();
  });

  it('updatePatch recaptures in place rather than appending a duplicate', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    let moduleId = '';
    engine.subscribeRack((next) => (moduleId = next[0]?.id ?? ''))();

    // Awaited: a save also captures the plugin's tone, which is a round-trip
    // to the audio side in the real engine.
    const patchId = await engine.savePatch(moduleId, 'Crunch');
    expect(patchId).not.toBeNull();

    await engine.updatePatch(patchId!, moduleId);

    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    // The list also carries the mock's stand-in patch pack, which is not the
    // user's and is never written back — the update must land in their own.
    const own = patches.filter((p) => !p.readOnly);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: patchId, name: 'Crunch' });
  });

  it('adding a module with a patch lands its look, not just its mapping', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));
    const sourceId = rack[0].id;

    engine.renameModule(sourceId, 'JTM45');
    engine.setModuleStyle(sourceId, { color: '#ff8800' });
    const patchId = await engine.savePatch(sourceId, 'JTM45');
    expect(patchId).not.toBeNull();

    // Dropping a patch tile from the drawer — the same patch must arrive
    // on the new card exactly as loading it onto an existing module would.
    engine.insertModule('Mock Amp', { serialPosition: 1 }, patchId!);
    stop();

    expect(rack[1]).toMatchObject({ displayName: 'JTM45', color: '#ff8800' });
  });

  it('a patch with no title override still names the new card after its own name', async () => {
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));

    // The mock's shipped pack patch is mapping-only — no displayName — but
    // the drawer tile shows the patch's name, so the drop must produce the
    // module the tile promised.
    engine.insertModule('Neural Amp Modeler', { serialPosition: 0 }, 'amalgam-jtm45');
    stop();

    expect(rack[0].displayName).toBe('JTM45');
  });

  it('saving under a new name retitles the card, so it matches the saved patch', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));

    // The card wears the previous patch's title — the shape of the reported
    // bug: load the pack's "Dark Repeats", tweak, save as "Repeats", and the
    // card and drawer tile kept saying "Dark Repeats".
    engine.renameModule(rack[0].id, 'Dark Repeats');
    const patchId = await engine.savePatch(rack[0].id, 'Repeats');
    stop();

    expect(rack[0].displayName).toBe('Repeats');
    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    const saved = patches.find((p) => p.id === patchId);
    // The stored title is the patch's own name, so the tile and every card it
    // is loaded on say "Repeats" too.
    expect(saved?.displayName).toBe('Repeats');
  });

  it('updating a patch retitles the card after the patch, not the patch after the card', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));

    const patchId = await engine.savePatch(rack[0].id, 'Crunch');
    engine.renameModule(rack[0].id, 'Dark Repeats');
    await engine.updatePatch(patchId!, rack[0].id);
    stop();

    expect(rack[0].displayName).toBe('Crunch');
    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    expect(patches.find((p) => p.id === patchId)?.displayName).toBe('Crunch');
  });

  it('updating a patch never captures a preview’s mapping', async () => {
    engine.insertModule('Neural Amp Modeler', { serialPosition: 0 });
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));
    const moduleId = rack[0].id;

    // A mapped module, saved, then rearranged: the module's own layout now
    // differs from both the saved patch and the pack patch.
    engine.loadPatch(moduleId, 'amalgam-jtm45');
    const patchId = await engine.savePatch(moduleId, 'Mine');
    const movedId = rack[0].params[0].knobId;
    engine.moveKnob(moduleId, movedId, 9);

    // The pointer rests on the pack's row on the way to "Update" — the try-on
    // replaces the module's knobs — and the update lands while it is applied.
    engine.previewPatch(moduleId, 'amalgam-jtm45');
    await engine.updatePatch(patchId!, moduleId);
    stop();

    // The capture is the module's own layout, and the try-on is settled.
    expect(rack[0].params.find((p) => p.knobId === movedId)?.pos).toBe(9);
    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    expect(patches.find((p) => p.id === patchId)?.knobs.some((k) => k.pos === 9)).toBe(true);
  });

  it('saving as a new patch never captures a preview’s mapping either', async () => {
    engine.insertModule('Neural Amp Modeler', { serialPosition: 0 });
    let rack: RackModule[] = [];
    const stop = engine.subscribeRack((next) => (rack = next));
    const moduleId = rack[0].id;

    engine.loadPatch(moduleId, 'amalgam-jtm45');
    engine.moveKnob(moduleId, rack[0].params[0].knobId, 9);

    engine.previewPatch(moduleId, 'amalgam-jtm45');
    const patchId = await engine.savePatch(moduleId, 'Mine');
    stop();

    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    expect(patches.find((p) => p.id === patchId)?.knobs.some((k) => k.pos === 9)).toBe(true);
  });

  it('renaming a patch renames its stored title with it', async () => {
    engine.insertModule('Mock Amp', { serialPosition: 0 });
    let rack: RackModule[] = [];
    engine.subscribeRack((next) => (rack = next))();

    const patchId = await engine.savePatch(rack[0].id, 'Repeats');
    engine.renamePatch(patchId!, 'Echoes');

    let patches: Patch[] = [];
    engine.subscribePatches((next) => (patches = next))();
    // Both halves move together, or the drawer tile would keep the old name.
    expect(patches.find((p) => p.id === patchId)).toMatchObject({
      name: 'Echoes',
      displayName: 'Echoes',
    });
  });
});
