import { describe, expect, it } from 'vitest';
import {
  adoptOrder,
  applyPreview,
  canRefileInto,
  previewOrder,
  type Reorder,
} from './drawerDrag.svelte';
import type { DrawerPatch } from '../../lib/engine/drawerGroups';
import type { DrawerSection, PatchNode, PluginsSection } from './drawerTree';
import type { Patch } from '../../lib/engine/types';

const patch = (over: Partial<Patch> & { id: string }): Patch => ({
  name: over.id,
  pluginName: 'Mock Amp',
  knobs: [],
  ...over,
});

const entry = (id: string): DrawerPatch => ({ patch: patch({ id }), category: ['Effects'] });

const section = (key: string): PatchNode => ({
  kind: 'patches',
  key,
  label: key,
  title: key,
  path: [key],
  entries: [],
  children: [],
  count: 0,
});

const plugins: PluginsSection = {
  kind: 'plugins',
  key: 'plugins',
  label: 'Plugins',
  title: 'Plugins',
  groups: [],
  count: 0,
};

const reorder = (over: Partial<Reorder> = {}): Reorder => ({
  homeKey: 'patches:Effects',
  sectionKey: 'patches:Effects',
  patchId: 'b',
  ids: ['a', 'b', 'c'],
  ...over,
});

describe('previewOrder', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('drops the tile after the one it is past the middle of', () => {
    expect(previewOrder(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('drops it before the one it is in the first half of', () => {
    expect(previewOrder(ids, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('works the same dragging backwards', () => {
    expect(previewOrder(ids, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(previewOrder(ids, 'd', 'b', true)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('reaches the first and the last slot', () => {
    expect(previewOrder(ids, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(previewOrder(ids, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a']);
  });

  // The dragover stream fires continuously over one tile; only a change is
  // worth writing back.
  it('says nothing when the order would not change', () => {
    expect(previewOrder(ids, 'a', 'b', false)).toBeNull();
    expect(previewOrder(ids, 'b', 'a', true)).toBeNull();
  });

  it('ignores the tile being dragged', () => {
    expect(previewOrder(ids, 'a', 'a', true)).toBeNull();
  });

  it('ignores a tile the order does not know', () => {
    expect(previewOrder(ids, 'a', 'zz', true)).toBeNull();
  });
});

describe('adoptOrder', () => {
  it('puts a tile arriving from elsewhere at the end, to be placed from there', () => {
    expect(adoptOrder(['a', 'c'], 'b')).toEqual(['a', 'c', 'b']);
  });

  // Carried back to where it came from: the section's own order already names
  // it, so it lands in the place it was taken from rather than at the end.
  it('leaves an order that already names the tile alone', () => {
    expect(adoptOrder(['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c']);
  });

  it('does not write through to the section it was given', () => {
    const ids = ['a', 'c'];
    adoptOrder(ids, 'b');
    expect(ids).toEqual(['a', 'c']);
  });
});

describe('canRefileInto', () => {
  const patches = [patch({ id: 'b' }), patch({ id: 'pack', readOnly: true })];

  it('takes a patch dragged in from another section', () => {
    expect(canRefileInto(reorder(), section('patches:Amps'), patches)).toBe(true);
  });

  it('refuses the section showing the preview — that one is a reorder', () => {
    expect(canRefileInto(reorder(), section('patches:Effects'), patches)).toBe(false);
  });

  // Once another section has adopted the drag, the one it came from is a
  // target again: carrying it back is how the move is called off.
  it('takes back the section the drag came from once another has adopted it', () => {
    const carried = reorder({ sectionKey: 'patches:Amps' });
    expect(canRefileInto(carried, section('patches:Effects'), patches)).toBe(true);
    expect(canRefileInto(carried, section('patches:Amps'), patches)).toBe(false);
  });

  it('refuses the plugins section', () => {
    expect(canRefileInto(reorder(), plugins, patches)).toBe(false);
  });

  // A pack files its own patches; the tile offers no tag button either.
  it('refuses a read-only pack patch', () => {
    expect(canRefileInto(reorder({ patchId: 'pack' }), section('patches:Amps'), patches)).toBe(
      false,
    );
  });

  it('refuses a patch that is no longer in the list', () => {
    expect(canRefileInto(reorder({ patchId: 'gone' }), section('patches:Amps'), patches)).toBe(
      false,
    );
  });

  it('refuses when no drag is in flight', () => {
    expect(canRefileInto(null, section('patches:Amps') as DrawerSection, patches)).toBe(false);
  });
});

describe('applyPreview', () => {
  const base = [entry('a'), entry('b'), entry('c')];

  it('reorders the section to the preview', () => {
    expect(applyPreview(base, ['c', 'a', 'b']).map((e) => e.patch.id)).toEqual(['c', 'a', 'b']);
  });

  // The preview is a snapshot taken when the drag began; a patch deleted
  // under it simply drops out rather than throwing.
  it('skips an id whose entry has gone', () => {
    expect(applyPreview(base, ['c', 'gone', 'a']).map((e) => e.patch.id)).toEqual(['c', 'a']);
  });

  it('drops an entry the preview does not name', () => {
    expect(applyPreview(base, ['a', 'b']).map((e) => e.patch.id)).toEqual(['a', 'b']);
  });

  // The tile carried in from another category: the section's own entries know
  // nothing of it until the drop re-files it, so the preview supplies it.
  it('splices in the tile being carried in', () => {
    expect(applyPreview(base, ['a', 'in', 'b', 'c'], entry('in')).map((e) => e.patch.id)).toEqual([
      'a',
      'in',
      'b',
      'c',
    ]);
  });

  it('still skips it where the order does not name it', () => {
    expect(applyPreview(base, ['a', 'b', 'c'], entry('in')).map((e) => e.patch.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
