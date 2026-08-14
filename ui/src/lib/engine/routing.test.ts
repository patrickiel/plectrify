import { describe, expect, it } from 'vitest';
import { laneName, makeLane, nextLaneName, normalizeRoutingState } from './routing';
import type { LaneMix } from './types';

const lane = (over: Partial<LaneMix> & { id: string }): LaneMix => ({
  name: '',
  gain: 1,
  pan: 0,
  muted: false,
  soloed: false,
  ...over,
});

describe('lane names', () => {
  it('mints A, B, C… by slot', () => {
    expect([0, 1, 25].map(laneName)).toEqual(['A', 'B', 'Z']);
    expect(makeLane('Clean').name).toBe('Clean');
  });

  it('picks the first default letter still free', () => {
    expect(nextLaneName([])).toBe('A');
    expect(nextLaneName([{ name: 'A' }, { name: 'B' }])).toBe('C');
    // A renamed lane frees its letter again.
    expect(nextLaneName([{ name: 'Clean' }, { name: 'B' }])).toBe('A');
  });
});

describe('normalizeRoutingState', () => {
  it('degrades anything unusable to no routing', () => {
    expect(normalizeRoutingState(null)).toEqual({ groups: [] });
    expect(normalizeRoutingState({})).toEqual({ groups: [] });
    // A legacy single-lane group was never a split.
    expect(normalizeRoutingState({ lanes: [lane({ id: 'l1' })] })).toEqual({ groups: [] });
  });

  it('drops malformed groups and lanes instead of throwing', () => {
    // A hand-edited file reaches this on the path that replaces live rack
    // metadata, so normalizing must never throw partway through an apply.
    expect(normalizeRoutingState({ groups: [null] })).toEqual({ groups: [] });
    expect(normalizeRoutingState({ groups: [{ id: 'g', position: 0, lanes: 5 }] })).toEqual({
      groups: [{ id: 'g', position: 0, lanes: [] }],
    });
    const routing = normalizeRoutingState({
      groups: [{ id: 'g', position: 0, lanes: [null, lane({ id: 'l1' })] }],
    });
    expect(routing.groups[0].lanes).toEqual([
      { ...lane({ id: 'l1' }), name: 'A', midi: undefined },
    ]);
  });

  it('keeps names a snapshot already carries', () => {
    const routing = normalizeRoutingState({
      groups: [
        {
          id: 'g',
          position: 0,
          lanes: [lane({ id: 'l1', name: 'Clean' }), lane({ id: 'l2', name: 'Dirty' })],
        },
      ],
    });
    expect(routing.groups[0].lanes.map((l) => l.name)).toEqual(['Clean', 'Dirty']);
  });

  it('keeps a valid lane MIDI trigger and strips a malformed one', () => {
    const routing = normalizeRoutingState({
      groups: [
        {
          id: 'g',
          position: 0,
          lanes: [
            lane({ id: 'l1', name: 'A', midi: { type: 'cc', channel: 1, number: 40 } }),
            lane({ id: 'l2', name: 'B', midi: { type: 'cc', channel: 99, number: 40 } as never }),
            lane({ id: 'l3', name: 'C' }),
          ],
        },
      ],
    });
    expect(routing.groups[0].lanes.map((l) => l.midi)).toEqual([
      { type: 'cc', channel: 1, number: 40 },
      undefined,
      undefined,
    ]);
  });

  it('falls back to the positional letter for unnamed lanes', () => {
    // Both the pre-names on-disk shape and every echo from C++, which does not
    // track names at all.
    const routing = normalizeRoutingState({
      groups: [
        {
          id: 'g',
          position: 0,
          lanes: [lane({ id: 'l1' }), lane({ id: 'l2' }), lane({ id: 'l3', name: '  ' })],
        },
      ],
    });
    expect(routing.groups[0].lanes.map((l) => l.name)).toEqual(['A', 'B', 'C']);
  });

  it('migrates the legacy single-group shape and names its lanes', () => {
    const routing = normalizeRoutingState({
      groupPosition: 2,
      lanes: [lane({ id: 'l1' }), lane({ id: 'l2', name: 'Fuzz' })],
    });
    expect(routing.groups).toHaveLength(1);
    expect(routing.groups[0].position).toBe(2);
    expect(routing.groups[0].lanes.map((l) => l.name)).toEqual(['A', 'Fuzz']);
  });

  it('does not mutate the lanes it was handed', () => {
    const source = { groups: [{ id: 'g', position: 0, lanes: [lane({ id: 'l1' })] }] };
    normalizeRoutingState(source);
    expect(source.groups[0].lanes[0].name).toBe('');
  });
});
