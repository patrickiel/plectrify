import { describe, expect, it } from 'vitest';
import {
  NO_TONE3000_ARTWORK,
  tone3000ArtworkSources,
  tone3000ArtworkUrl,
  findTone3000Patch,
  formatLabel,
  gearLabel,
  isSupportedFormat,
  isTone3000Provenance,
  patchesMissingCaptures,
  referencedFiles,
  tone3000Category,
  type Tone3000Provenance,
} from './tone3000';

const provenance = (over: Partial<Tone3000Provenance> = {}): Tone3000Provenance => ({
  toneId: 42,
  modelId: 7,
  title: 'JTM45 Crunch',
  gear: 'amp-cab',
  format: 'nam',
  creator: { username: 'someone' },
  file: 'nam/42-7.nam',
  ...over,
});

describe('isTone3000Provenance', () => {
  it('accepts a complete record', () => {
    expect(isTone3000Provenance(provenance())).toBe(true);
  });

  it('accepts gear, format and licence values this build has never heard of', () => {
    // TONE3000 owns this vocabulary and adds to it. A patch naming a new gear
    // type must keep working, not lose its identity on the next release.
    expect(
      isTone3000Provenance(provenance({ gear: 'quantum-rig', license: 'some-new-licence' })),
    ).toBe(true);
  });

  it('carries unknown extra fields through without objecting', () => {
    expect(isTone3000Provenance({ ...provenance(), somethingNew: { nested: true } })).toBe(true);
  });

  it('rejects a record a repair could not act on', () => {
    expect(isTone3000Provenance(provenance({ file: '' }))).toBe(false);
    expect(isTone3000Provenance({ ...provenance(), toneId: '42' })).toBe(false);
    expect(isTone3000Provenance({ ...provenance(), creator: {} })).toBe(false);
    expect(isTone3000Provenance(null)).toBe(false);
    expect(isTone3000Provenance(undefined)).toBe(false);
    expect(isTone3000Provenance('nam/42-7.nam')).toBe(false);
  });
});

describe('labels', () => {
  it('prints the formats and gear types we know', () => {
    expect(formatLabel('nam')).toBe('NAM');
    expect(formatLabel('ir')).toBe('IR');
    expect(gearLabel('amp-cab')).toBe('Amp + Cab');
  });

  it('prints an unknown id as itself rather than as a placeholder', () => {
    expect(gearLabel('quantum-rig')).toBe('quantum-rig');
    expect(formatLabel('proteus')).toBe('PROTEUS');
  });

  it('supports only the formats Neural Amp Modeler can load', () => {
    expect(isSupportedFormat('nam')).toBe(true);
    expect(isSupportedFormat('ir')).toBe(true);
    expect(isSupportedFormat('aida-x')).toBe(false);
  });
});

describe('drawer filing', () => {
  it('files a downloaded tone under TONE3000 by its gear', () => {
    expect(tone3000Category(provenance())).toEqual(['TONE3000', 'Amp + Cab']);
  });

  it('still files an unknown gear somewhere sensible', () => {
    expect(tone3000Category(provenance({ gear: 'quantum-rig' }))).toEqual([
      'TONE3000',
      'quantum-rig',
    ]);
  });
});

describe('missing captures', () => {
  const patches = [
    { id: 'a', tone3000: provenance() },
    { id: 'b', tone3000: provenance({ file: 'nam/9-9.nam' }) },
    { id: 'c' },
  ];

  it('marks the patches whose model file is gone', () => {
    expect(patchesMissingCaptures(patches, ['nam/9-9.nam'])).toEqual(new Set(['b']));
  });

  it('marks every patch sharing one missing file', () => {
    const twice = [...patches, { id: 'd', tone3000: provenance({ file: 'nam/9-9.nam' }) }];
    expect(patchesMissingCaptures(twice, ['nam/9-9.nam'])).toEqual(new Set(['b', 'd']));
  });

  it('never marks a patch that has no TONE3000 capture to lose', () => {
    expect(patchesMissingCaptures(patches, ['nam/42-7.nam', 'nam/9-9.nam']).has('c')).toBe(false);
  });

  it('reports each referenced file once, which is what a cleanup must spare', () => {
    const twice = [...patches, { id: 'd', tone3000: provenance() }];
    expect(referencedFiles(twice).sort()).toEqual(['nam/42-7.nam', 'nam/9-9.nam']);
  });
});

describe('duplicate downloads', () => {
  const patches = [
    { id: 'patch-b', tone3000: provenance({ modelId: 8, file: 'nam/42-8.nam' }) },
    { id: 'patch-a', tone3000: provenance() },
    { id: 'patch-c', tone3000: provenance({ toneId: 9, file: 'nam/9-1.nam' }) },
    { id: 'patch-plain' },
  ];

  it('finds nothing for a tone the user has never downloaded', () => {
    expect(findTone3000Patch(patches, { toneId: 1234, modelId: 7 })).toBeUndefined();
  });

  it('finds the patch holding the very same capture', () => {
    expect(findTone3000Patch(patches, { toneId: 42, modelId: 7 })?.id).toBe('patch-a');
    expect(findTone3000Patch(patches, { toneId: 42, modelId: 8 })?.id).toBe('patch-b');
  });

  it('treats another take of the same tone as the same patch', () => {
    expect(findTone3000Patch(patches, { toneId: 9, modelId: 5 })?.id).toBe('patch-c');
  });

  it('answers the same whatever order the directory was read in', () => {
    const reversed = [...patches].reverse();
    expect(findTone3000Patch(reversed, { toneId: 42, modelId: 99 })?.id).toBe('patch-a');
    expect(findTone3000Patch(patches, { toneId: 42, modelId: 99 })?.id).toBe('patch-a');
  });

  it('never matches a patch that came from somewhere else', () => {
    expect(findTone3000Patch([{ id: 'patch-plain' }], { toneId: 42, modelId: 7 })).toBeUndefined();
  });
});

describe('cover art', () => {
  const remote = { toneId: 42, imageUrl: 'https://cdn.example.invalid/42.jpg' };
  const onDisk = { root: 'https://juce.backend/tone3000/images/', cached: new Set([42]) };

  it('is shown from the local copy once the engine has one', () => {
    expect(tone3000ArtworkUrl(remote, onDisk)).toBe('https://juce.backend/tone3000/images/42.jpg');
  });

  it('never falls back to the remote image', () => {
    expect(tone3000ArtworkUrl(remote, NO_TONE3000_ARTWORK)).toBeUndefined();
    expect(tone3000ArtworkUrl({ ...remote, toneId: 7 }, onDisk)).toBeUndefined();
    expect(tone3000ArtworkUrl(remote, { root: '', cached: new Set([42]) })).toBeUndefined();
  });

  it("keeps the mock's inline artwork, which touches no network", () => {
    const inline = { toneId: 1, imageUrl: 'data:image/svg+xml;utf8,x' };
    expect(tone3000ArtworkUrl(inline, NO_TONE3000_ARTWORK)).toBe(inline.imageUrl);
  });

  it('shows nothing for a module with no tone', () => {
    expect(tone3000ArtworkUrl(undefined, onDisk)).toBeUndefined();
  });

  it('lists each tone once for the engine to catch up on, https only', () => {
    expect(
      tone3000ArtworkSources([
        remote,
        undefined,
        { ...remote, imageUrl: 'https://cdn.example.invalid/other.jpg' },
        { toneId: 5, imageUrl: 'http://cdn.example.invalid/5.jpg' },
        { toneId: 6, imageUrl: 'data:image/png;base64,x' },
        { toneId: 8 },
      ]),
    ).toEqual([remote]);
  });
});
