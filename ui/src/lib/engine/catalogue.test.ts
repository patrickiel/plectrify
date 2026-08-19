import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOGUE_STATE,
  UNCATEGORISED,
  describeInstallError,
  dependencyName,
  filterLinks,
  filterPackages,
  groupByCategory,
  isUpdatable,
  normalizeCatalogueState,
  bundlePendingBytes,
  bundlePendingIds,
  pendingDownloadBytes,
  pendingInstallIds,
  queueInstallRows,
  reduceInstallProgress,
  resolveInstallIds,
  settleInstallRun,
  stageForItem,
  tagCounts,
  type CataloguePackage,
  type CatalogueLink,
  type CatalogueBundle,
  type InstallProgress,
  type InstallRunState,
  type CatalogueState,
} from './catalogue';

function link(category: string[], label: string, tags: string[] = []): CatalogueLink {
  return { category, tags, label, url: `https://example.invalid/${label}`, note: '' };
}

function item(overrides: Partial<CataloguePackage> = {}): CataloguePackage {
  return {
    id: 'zam-plugins',
    kind: 'plugin',
    category: ['Effects'],
    tags: [],
    name: 'ZamPlugins',
    purpose: 'Gate, compressor, EQ',
    version: '4.5',
    licenseId: 'GPL-2.0-or-later',
    licenseUrl: 'https://example.invalid/COPYING',
    projectUrl: 'https://example.invalid/repo',
    downloadBytes: 1000,
    selfHosted: false,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: '',
    dependsOn: '',
    ...overrides,
  };
}

function progress(overrides: Partial<InstallProgress> = {}): InstallProgress {
  return {
    id: 'zam-plugins',
    name: 'ZamPlugins',
    stage: 'downloading',
    index: 1,
    count: 1,
    received: 0,
    total: 1000,
    ...overrides,
  };
}

function state(items: CataloguePackage[]): CatalogueState {
  return { ...EMPTY_CATALOGUE_STATE, items };
}

describe('reduceInstallProgress', () => {
  it('records the latest stage for a package', () => {
    let run: InstallRunState = {};
    run = reduceInstallProgress(run, progress({ stage: 'downloading', received: 500 }));
    expect(run['zam-plugins']).toMatchObject({ stage: 'downloading', received: 500 });

    run = reduceInstallProgress(run, progress({ stage: 'verifying' }));
    expect(run['zam-plugins'].stage).toBe('verifying');
  });

  it('keeps rows independent so one failure does not disturb another', () => {
    let run: InstallRunState = {};
    run = reduceInstallProgress(run, progress({ id: 'a', stage: 'downloading', received: 10 }));
    run = reduceInstallProgress(run, progress({ id: 'b', stage: 'failed', error: 'network' }));

    expect(run['a']).toMatchObject({ stage: 'downloading', received: 10 });
    expect(run['b']).toMatchObject({ stage: 'failed', error: 'network' });
  });

  it('ignores events that arrive after a row has finished', () => {
    // The bridge does not guarantee ordering; a stale 'downloading' landing
    // after 'failed' would leave the row spinning forever.
    let run: InstallRunState = {};
    run = reduceInstallProgress(run, progress({ stage: 'failed', error: 'checksum' }));
    run = reduceInstallProgress(run, progress({ stage: 'downloading', received: 900 }));

    expect(run['zam-plugins']).toMatchObject({ stage: 'failed', error: 'checksum' });
  });

  it('ignores a duplicate terminal event', () => {
    let run: InstallRunState = {};
    run = reduceInstallProgress(run, progress({ stage: 'installed' }));
    const afterFirst = run;
    run = reduceInstallProgress(run, progress({ stage: 'installed' }));

    expect(run).toBe(afterFirst);
  });

  it('treats an empty error string as no error', () => {
    const run = reduceInstallProgress({}, progress({ stage: 'installed', error: '' }));
    expect(run['zam-plugins'].error).toBeUndefined();
  });
});

describe('queueInstallRows', () => {
  it('marks every requested row queued', () => {
    const run = queueInstallRows({}, ['a', 'b']);
    expect(run['a'].stage).toBe('queued');
    expect(run['b'].stage).toBe('queued');
  });

  it('does not disturb rows outside the request', () => {
    const existing: InstallRunState = {
      c: { stage: 'downloading', received: 5, total: 10 },
    };
    const run = queueInstallRows(existing, ['a']);
    expect(run['c']).toEqual(existing['c']);
  });
});

describe('settleInstallRun', () => {
  it('keeps failures visible and drops everything else', () => {
    const run: InstallRunState = {
      ok: { stage: 'installed', received: 1, total: 1 },
      bad: { stage: 'failed', received: 0, total: 1, error: 'network' },
      skip: { stage: 'skipped', received: 0, total: 0 },
    };

    const settled = settleInstallRun(run);
    expect(Object.keys(settled)).toEqual(['bad']);
  });
});

describe('stageForItem', () => {
  it('prefers live progress over disk state', () => {
    const run: InstallRunState = {
      'zam-plugins': { stage: 'downloading', received: 0, total: 1 },
    };
    expect(stageForItem(item({ installed: true }), run)).toBe('downloading');
  });

  it('falls back to disk state when nothing is running', () => {
    expect(stageForItem(item({ installed: true }), {})).toBe('installed');
    expect(stageForItem(item({ installed: false }), {})).toBe('missing');
  });
});

describe('isUpdatable', () => {
  it('is true only for an installed package at a different version', () => {
    expect(isUpdatable(item({ installed: true, updateAvailable: true }))).toBe(true);
    expect(isUpdatable(item({ installed: true, updateAvailable: false }))).toBe(false);
    expect(isUpdatable(item({ installed: false, updateAvailable: true }))).toBe(false);
  });

  it('is false for an unlisted package, which has nothing to update to', () => {
    expect(isUpdatable(item({ installed: true, updateAvailable: true, unlisted: true }))).toBe(
      false,
    );
  });

  it('is false where this platform has no payload to update to', () => {
    // Installed before the catalogue stopped offering this OS a build: the
    // version still differs, but Update could only ever fail.
    expect(isUpdatable(item({ installed: true, updateAvailable: true, available: false }))).toBe(
      false,
    );
  });
});

describe('resolveInstallIds', () => {
  // The direction that matters: a patch names the plugin it was built for, so
  // the plugin has to be on disk first. The reverse edge does not exist — a
  // plugin is complete with no patches at all.
  const patch = item({ id: 'jtm45', dependsOn: 'nam' });
  const plugin = item({ id: 'nam' });

  it('puts a dependency ahead of the package that named it', () => {
    expect(resolveInstallIds(['jtm45'], [patch, plugin])).toEqual(['nam', 'jtm45']);
  });

  it('installs a package with no dependency on its own', () => {
    expect(resolveInstallIds(['nam'], [patch, plugin])).toEqual(['nam']);
  });

  it('names each package once when both are asked for', () => {
    expect(resolveInstallIds(['nam', 'jtm45'], [patch, plugin])).toEqual(['nam', 'jtm45']);
  });

  it('follows a chain to its end', () => {
    const items = [
      item({ id: 'a', dependsOn: 'b' }),
      item({ id: 'b', dependsOn: 'c' }),
      item({ id: 'c' }),
    ];
    expect(resolveInstallIds(['a'], items)).toEqual(['c', 'b', 'a']);
  });

  it('drops an id with no row, as the installer drops it', () => {
    expect(resolveInstallIds(['ghost', 'nam'], [plugin])).toEqual(['nam']);
    expect(resolveInstallIds(['jtm45'], [item({ id: 'jtm45', dependsOn: 'ghost' })])).toEqual([
      'jtm45',
    ]);
  });

  it('terminates on a loop rather than hanging', () => {
    // `validate` refuses to publish one; this is what keeps a bad catalogue
    // from taking the panel down with it.
    const items = [item({ id: 'a', dependsOn: 'b' }), item({ id: 'b', dependsOn: 'a' })];
    expect(resolveInstallIds(['a'], items).sort()).toEqual(['a', 'b']);
  });
});

describe('dependencyName', () => {
  it('names the package a row depends on', () => {
    const items = [
      item({ id: 'jtm45', dependsOn: 'nam' }),
      item({ id: 'nam', name: 'Neural Amp Modeler' }),
    ];

    expect(dependencyName(items[0], items)).toBe('Neural Amp Modeler');
    expect(dependencyName(items[1], items)).toBe('');
  });

  it('falls back to the id when the catalogue does not define it', () => {
    const orphan = item({ id: 'jtm45', dependsOn: 'nam' });
    expect(dependencyName(orphan, [orphan])).toBe('nam');
  });
});

describe('pendingInstallIds', () => {
  it('covers missing packages and available updates', () => {
    const s = state([
      item({ id: 'missing' }),
      item({ id: 'current', installed: true, installedVersion: '4.5' }),
      item({ id: 'stale', installed: true, installedVersion: '4.4', updateAvailable: true }),
    ]);

    expect(pendingInstallIds(s, {})).toEqual(['missing', 'stale']);
  });

  it('excludes rows already running but includes ones that failed', () => {
    const s = state([item({ id: 'a' }), item({ id: 'b' })]);
    const run: InstallRunState = {
      a: { stage: 'downloading', received: 0, total: 1 },
      b: { stage: 'failed', received: 0, total: 1, error: 'network' },
    };

    expect(pendingInstallIds(s, run)).toEqual(['b']);
  });

  it('never offers to install an unlisted package', () => {
    const s = state([item({ id: 'gone', installed: true, unlisted: true })]);
    expect(pendingInstallIds(s, {})).toEqual([]);
  });

  it('never offers to install a package this platform is not offered', () => {
    // Queuing one would be a guaranteed "not available for this platform"
    // failure — the row is greyed, and Install all must agree with it.
    const s = state([item({ id: 'windows-only', available: false }), item({ id: 'here' })]);
    expect(pendingInstallIds(s, {})).toEqual(['here']);
  });
});

describe('pendingDownloadBytes', () => {
  it('sums only what is still to fetch', () => {
    const s = state([
      item({ id: 'a', downloadBytes: 100 }),
      item({ id: 'b', downloadBytes: 250 }),
      item({ id: 'c', downloadBytes: 999, installed: true, installedVersion: '4.5' }),
    ]);

    expect(pendingDownloadBytes(s, {})).toBe(350);
  });
});

describe('describeInstallError', () => {
  it('explains what the user should do about a locked plugin', () => {
    expect(describeInstallError('locked')).toContain('Close and reopen');
  });

  it('says who owns the plugin Plectrify refused to overwrite', () => {
    expect(describeInstallError('another copy is already installed')).toContain(
      'Plectrify did not put it there',
    );
  });

  it('passes an unrecognised message through rather than swallowing it', () => {
    expect(describeInstallError('disk full')).toBe('disk full');
  });

  it('has a fallback for a missing reason', () => {
    expect(describeInstallError(undefined)).toBe('Something went wrong.');
  });
});

describe('groupCatalogueLinks', () => {
  it('groups by category, keeping the catalogue order of both groups and links', () => {
    const groups = groupByCategory([
      link(['Captures'], 'tone3000'),
      link(['Pedals'], 'kvr'),
      link(['Captures'], 'aida'),
    ]);

    // 'Captures' stays first because it was seen first, and 'aida' joins it
    // rather than opening a second group of the same name.
    expect(groups.map((group) => group.category)).toEqual(['Captures', 'Pedals']);
    expect(groups[0].entries.map((l) => l.label)).toEqual(['tone3000', 'aida']);
  });

  it('merges headings case-insensitively, printing the first-seen casing', () => {
    const groups = groupByCategory([link(['Test', 'Sub'], 'one'), link(['test', 'Other'], 'two')]);

    expect(groups.map((group) => group.category)).toEqual(['Test']);
    expect(groups[0].children.map((child) => child.category)).toEqual(['Sub', 'Other']);
  });

  it('gathers uncategorised links under one trailing heading', () => {
    const groups = groupByCategory([
      link([], 'loose-first'),
      link(['Captures'], 'tone3000'),
      link([], 'loose-second'),
    ]);

    // Last, despite having been listed first: a fallback heading above a named
    // one would read as the more important of the two.
    expect(groups.map((group) => group.category)).toEqual(['Captures', UNCATEGORISED]);
    expect(groups[1].entries.map((l) => l.label)).toEqual(['loose-first', 'loose-second']);
  });

  it('has no groups for no links, so the panel renders no empty section', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe('groupByCategory nesting', () => {
  it('files a longer path as a subsection of its parent', () => {
    const groups = groupByCategory([
      item({ id: 'zam', category: ['Effects'] }),
      item({ id: 'dragonfly', category: ['Effects', 'Reverb'] }),
      item({ id: 'qdelay', category: ['Effects', 'Delay'] }),
      item({ id: 'reevr', category: ['Effects', 'Reverb'] }),
    ]);

    expect(groups.map((group) => group.category)).toEqual(['Effects']);
    // The rack that spans every subsection stays on the parent rather than
    // being pushed into one of them.
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['zam']);
    // Subsections in first-appearance order, and the second 'Reverb' joins the
    // first rather than opening a sibling of the same name.
    expect(groups[0].children.map((child) => child.category)).toEqual(['Reverb', 'Delay']);
    expect(groups[0].children[0].entries.map((entry) => entry.id)).toEqual(['dragonfly', 'reevr']);
  });

  it('creates a parent no package sits directly under', () => {
    // Otherwise a catalogue that only ever writes the full path would render a
    // bare 'Reverb' at the top level, saying nothing about what it is a kind of.
    const groups = groupByCategory([item({ id: 'dragonfly', category: ['Effects', 'Reverb'] })]);

    expect(groups.map((group) => group.category)).toEqual(['Effects']);
    expect(groups[0].entries).toEqual([]);
    expect(groups[0].children.map((child) => child.category)).toEqual(['Reverb']);
  });

  it('keeps same-named subsections apart by their whole path', () => {
    const groups = groupByCategory([
      item({ id: 'a', category: ['Amps', 'Clean'] }),
      item({ id: 'b', category: ['Effects', 'Clean'] }),
    ]);

    expect(groups.map((group) => group.path)).toEqual([['Amps'], ['Effects']]);
    expect(groups[0].children[0].path).toEqual(['Amps', 'Clean']);
    expect(groups[1].children[0].path).toEqual(['Effects', 'Clean']);
    expect(groups[0].children[0].entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('nests as deep as the catalogue asks, so depth is never a UI decision', () => {
    const groups = groupByCategory([item({ id: 'a', category: ['Effects', 'Delay', 'Tape'] })]);

    expect(groups[0].children[0].children[0].path).toEqual(['Effects', 'Delay', 'Tape']);
    expect(groups[0].children[0].children[0].entries.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('normalizeCatalogueState links', () => {
  it('carries the category across the bridge', () => {
    const state = normalizeCatalogueState({
      links: [
        { category: ['Captures', 'IRs'], label: 'TONE3000', url: 'https://example.invalid/t' },
      ],
    });

    expect(state.links[0].category).toEqual(['Captures', 'IRs']);
  });

  it('leaves a link with no category uncategorised rather than dropping it', () => {
    const state = normalizeCatalogueState({
      links: [{ label: 'TONE3000', url: 'https://example.invalid/t' }],
    });

    expect(state.links).toHaveLength(1);
    expect(state.links[0].category).toEqual([]);
  });

  it('carries a link’s tags across the bridge, deduplicated', () => {
    const state = normalizeCatalogueState({
      links: [
        {
          tags: ['Reverb', ' Reverb ', '', 'Delay'],
          label: 'Valhalla',
          url: 'https://example.invalid/v',
        },
        { label: 'HISE', url: 'https://example.invalid/h' },
      ],
    });

    expect(state.links[0].tags).toEqual(['Reverb', 'Delay']);
    // An untagged link is a link under no chip, not a malformed one.
    expect(state.links[1].tags).toEqual([]);
  });

  it('drops a non-https link, which the browser would open all the same', () => {
    const state = normalizeCatalogueState({
      links: [{ category: 'Captures', label: 'TONE3000', url: 'http://example.invalid/t' }],
    });

    expect(state.links).toEqual([]);
  });
});

describe('groupByCategory over packages', () => {
  it('keeps content beside the plugin it belongs with', () => {
    // The point of the unified list: an IR bundle groups under the same heading
    // as the loader that plays it, rather than being exiled to a section named
    // after how it happens to be packaged.
    const groups = groupByCategory([
      item({ id: 'reev-r', kind: 'plugin', category: ['Cabs & IRs'] }),
      item({ id: 'cab-irs', kind: 'content', category: ['Cabs & IRs'] }),
      item({ id: 'zam-plugins', kind: 'plugin', category: ['Effects'] }),
    ]);

    expect(groups.map((group) => group.category)).toEqual(['Cabs & IRs', 'Effects']);
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['reev-r', 'cab-irs']);
  });

  it('groups by category alone, never by kind', () => {
    const groups = groupByCategory([
      item({ id: 'a', kind: 'content', category: ['Amps'] }),
      item({ id: 'b', kind: 'plugin', category: ['Amps'] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((entry) => entry.kind)).toEqual(['content', 'plugin']);
  });
});

describe('normalizeCatalogueState packages', () => {
  const base = { id: 'x', name: 'X', version: '1' };

  it('reads kind and category off a package', () => {
    const state = normalizeCatalogueState({
      items: [{ ...base, kind: 'content', category: ['Cabs & IRs'], dir: 'C:/irs' }],
    });

    expect(state.items[0]).toMatchObject({
      kind: 'content',
      category: ['Cabs & IRs'],
      dir: 'C:/irs',
    });
  });

  it('reads a bare string as a one-segment path, as the authoring format does', () => {
    // The catalogue lets a single heading go without brackets, so a normalizer
    // stricter than the format it mirrors would drop headings the native side
    // is willing to publish.
    const state = normalizeCatalogueState({ items: [{ ...base, category: 'Effects' }] });

    expect(state.items[0].category).toEqual(['Effects']);
  });

  it('drops blank segments rather than rendering an unnamed subsection', () => {
    const state = normalizeCatalogueState({
      items: [{ ...base, category: ['  Effects  ', '', 'Reverb', 7] }],
    });

    expect(state.items[0].category).toEqual(['Effects', 'Reverb']);
  });

  it('reads tags off a package, dropping blanks and repeats', () => {
    const state = normalizeCatalogueState({
      items: [{ ...base, tags: [' Delay ', 'Delay', '', 'Reverb', 7] }],
    });

    expect(state.items[0].tags).toEqual(['Delay', 'Reverb']);
  });

  it('leaves a package with no tags answering to no chip', () => {
    // An older engine sends none at all, and an untagged entry is a legitimate
    // authoring choice — neither may become a chip of its own.
    expect(normalizeCatalogueState({ items: [{ ...base }] }).items[0].tags).toEqual([]);
  });

  it('treats anything that is not exactly "content" as a plugin', () => {
    // Safe only because nothing on this side acts on kind — where the payload
    // landed was settled natively. A UI that branched on this would be a bug.
    for (const kind of [undefined, '', 'Content', 'executable']) {
      expect(normalizeCatalogueState({ items: [{ ...base, kind }] }).items[0].kind).toBe('plugin');
    }
  });

  it('treats a package as available unless the engine says otherwise', () => {
    // Older engines never send the field; everything they offer is
    // installable, so absence must not grey the whole catalogue.
    expect(normalizeCatalogueState({ items: [{ ...base }] }).items[0].available).toBe(true);
    expect(
      normalizeCatalogueState({ items: [{ ...base, available: false }] }).items[0].available,
    ).toBe(false);
  });

  it('leaves a package with no category uncategorised rather than dropping it', () => {
    const state = normalizeCatalogueState({ items: [{ ...base, kind: 'plugin' }] });

    expect(state.items).toHaveLength(1);
    expect(state.items[0].category).toEqual([]);
    expect(groupByCategory(state.items)[0].category).toBe(UNCATEGORISED);
  });

  it('reads a bundle\u2019s packageIds, which now span plugins and content alike', () => {
    const state = normalizeCatalogueState({
      bundles: [
        {
          id: 'starter',
          name: 'Starter',
          version: '5',
          packageIds: ['reev-r', 'cab-irs'],
          missingPackageIds: ['cab-irs'],
          outdatedPackageIds: [],
        },
      ],
    });

    expect(state.bundles[0].packageIds).toEqual(['reev-r', 'cab-irs']);
    expect(state.bundles[0].missingPackageIds).toEqual(['cab-irs']);
  });
});

describe('bundlePendingIds', () => {
  function starter(overrides: Partial<CatalogueBundle> = {}): CatalogueBundle {
    return {
      id: 'starter',
      name: 'Starter',
      description: '',
      version: '10',
      packageIds: ['reev-r', 'jtm45'],
      missingPackageIds: ['reev-r', 'jtm45'],
      outdatedPackageIds: [],
      installedVersion: '',
      installed: false,
      updateAvailable: false,
      ...overrides,
    };
  }

  it('skips members this platform is not offered', () => {
    // The Starter bundle names one list of ids on every OS, so the mac build
    // has to drop the two it cannot install rather than queue them and fail.
    const s = state([item({ id: 'reev-r' }), item({ id: 'jtm45', available: false })]);
    expect(bundlePendingIds(starter(), s, {})).toEqual(['reev-r']);
  });

  it('skips an id the catalogue no longer publishes', () => {
    const s = state([item({ id: 'reev-r' })]);
    expect(bundlePendingIds(starter(), s, {})).toEqual(['reev-r']);
  });

  it('excludes members already running but includes ones that failed', () => {
    const s = state([item({ id: 'reev-r' }), item({ id: 'jtm45' })]);
    const run: InstallRunState = {
      'reev-r': { stage: 'downloading', received: 0, total: 1 },
      jtm45: { stage: 'failed', received: 0, total: 1, error: 'network' },
    };
    expect(bundlePendingIds(starter(), s, run)).toEqual(['jtm45']);
  });
});

describe('bundlePendingBytes over the unified list', () => {
  it('counts content toward a bundle\u2019s download size', () => {
    // Content used to live in its own array, which the size had to be taught to
    // look in as well; one list means it cannot be forgotten again.
    const s: CatalogueState = {
      ...EMPTY_CATALOGUE_STATE,
      items: [
        item({ id: 'reev-r', kind: 'plugin', downloadBytes: 100 }),
        item({ id: 'cab-irs', kind: 'content', downloadBytes: 250 }),
      ],
    };
    const bundle: CatalogueBundle = {
      id: 'starter',
      name: 'Starter',
      description: '',
      version: '5',
      packageIds: ['reev-r', 'cab-irs'],
      missingPackageIds: ['reev-r', 'cab-irs'],
      outdatedPackageIds: [],
      installedVersion: '',
      installed: false,
      updateAvailable: false,
    };

    expect(bundlePendingBytes(bundle, s, {})).toBe(350);
  });
});

describe('filterPackages', () => {
  const items = [
    item({ id: 'reev-r', name: 'REEV-R', purpose: 'Convolution reverb', installed: true }),
    item({ id: 'fire', name: 'Fire', purpose: 'Multiband distortion', category: ['Drive'] }),
    item({
      id: 'qdelay',
      name: 'QDelay',
      purpose: 'Dual delay',
      installed: true,
      updateAvailable: true,
    }),
    item({ id: 'mac-only', name: 'MacOnly', purpose: 'Tape', available: false }),
  ];

  it('shows every package under the all view', () => {
    expect(filterPackages(items, 'all', '').map((i) => i.id)).toEqual([
      'reev-r',
      'fire',
      'qdelay',
      'mac-only',
    ]);
  });

  it('keeps only what this platform could actually add', () => {
    // MacOnly is missing too, but its row can never offer a button — a view
    // answering "what can I add" that lists it is answering something else.
    expect(filterPackages(items, 'installable', '').map((i) => i.id)).toEqual(['fire']);
  });

  it('keeps only the packages with a newer version published', () => {
    expect(filterPackages(items, 'updatable', '').map((i) => i.id)).toEqual(['qdelay']);
  });

  it('matches the query against name, purpose and heading alike', () => {
    expect(filterPackages(items, 'all', 'reev').map((i) => i.id)).toEqual(['reev-r']);
    expect(filterPackages(items, 'all', 'DELAY').map((i) => i.id)).toEqual(['qdelay']);
    expect(filterPackages(items, 'all', 'drive').map((i) => i.id)).toEqual(['fire']);
  });

  it('ignores surrounding whitespace and treats an empty query as no filter', () => {
    expect(filterPackages(items, 'all', '   ')).toHaveLength(items.length);
    expect(filterPackages(items, 'all', '  fire  ').map((i) => i.id)).toEqual(['fire']);
  });

  it('applies the view and the query together', () => {
    expect(filterPackages(items, 'installable', 'reev')).toEqual([]);
  });
});

describe('filterLinks', () => {
  const links = [
    { ...link(['Pro freeware'], 'Valhalla Supermassive'), note: 'Vast reverbs and delays' },
    { ...link(['More plugins'], 'BYOD'), note: 'Build-your-own distortion' },
  ];

  it('matches a link on its label, its note and its heading', () => {
    expect(filterLinks(links, 'valhalla').map((l) => l.label)).toEqual(['Valhalla Supermassive']);
    expect(filterLinks(links, 'distortion').map((l) => l.label)).toEqual(['BYOD']);
    expect(filterLinks(links, 'freeware').map((l) => l.label)).toEqual(['Valhalla Supermassive']);
  });

  it('returns every link for an empty query', () => {
    expect(filterLinks(links, '')).toHaveLength(2);
  });
});

describe('tagCounts', () => {
  it('counts by tag, in first-appearance order, an entry under each of its own', () => {
    const counts = tagCounts([
      item({ id: 'a', tags: ['Delay', 'Modulation'] }),
      item({ id: 'b', tags: ['Reverb'] }),
      item({ id: 'c', tags: ['Delay'] }),
    ]);
    expect(counts).toEqual([
      { tag: 'Delay', count: 2 },
      { tag: 'Modulation', count: 1 },
      { tag: 'Reverb', count: 1 },
    ]);
  });

  it('counts packages and links as one list, so a chip speaks for both cards', () => {
    const counts = tagCounts([
      item({ id: 'a', tags: ['Reverb'] }),
      link(['Pro freeware'], 'Valhalla Supermassive', ['Reverb', 'Delay']),
    ]);
    expect(counts).toEqual([
      { tag: 'Reverb', count: 2 },
      { tag: 'Delay', count: 1 },
    ]);
  });

  it('offers no chip for an untagged entry rather than a fallback one', () => {
    expect(tagCounts([item({ id: 'a' }), item({ id: 'b', tags: ['Amps'] })])).toEqual([
      { tag: 'Amps', count: 1 },
    ]);
  });

  it('counts an entry once under a tag it somehow repeats', () => {
    expect(tagCounts([item({ id: 'a', tags: ['Delay', 'Delay'] })])).toEqual([
      { tag: 'Delay', count: 1 },
    ]);
  });
});

describe('filterPackages by tag', () => {
  const items = [
    item({ id: 'a', name: 'Fire', tags: ['Distortion'] }),
    item({ id: 'b', name: 'Verb', tags: ['Reverb', 'Distortion'] }),
    item({ id: 'c', name: 'Amp', tags: ['Amps'], installed: true }),
    item({ id: 'd', name: 'Tool' }),
  ];

  it('keeps every entry carrying the tag, wherever it is filed', () => {
    expect(filterPackages(items, 'all', '', 'Distortion').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('narrows alongside the view and the query rather than replacing them', () => {
    expect(filterPackages(items, 'installed', '', 'Distortion')).toEqual([]);
    expect(filterPackages(items, 'all', 'verb', 'Distortion').map((i) => i.id)).toEqual(['b']);
  });

  it('drops an untagged entry from every chip, and treats no tag as everything', () => {
    expect(filterPackages(items, 'all', '', 'Amps').map((i) => i.id)).toEqual(['c']);
    expect(filterPackages(items, 'all', '', '')).toHaveLength(4);
  });

  it('matches a tag typed into the filter box, since it is on a chip on screen', () => {
    expect(filterPackages(items, 'all', 'reverb').map((i) => i.id)).toEqual(['b']);
  });
});

describe('filterLinks by tag', () => {
  const links = [
    link(['Pro freeware'], 'Valhalla', ['Reverb', 'Delay']),
    link(['Open source'], 'BYOD', ['Distortion']),
    link(['Open source'], 'HISE'),
  ];

  it('narrows the links a chip rather than hiding them, which is why they carry tags', () => {
    expect(filterLinks(links, '', 'Reverb').map((l) => l.label)).toEqual(['Valhalla']);
  });

  it('applies the chip and the query together, and no chip means every link', () => {
    expect(filterLinks(links, 'byod', 'Reverb')).toEqual([]);
    expect(filterLinks(links, '', '')).toHaveLength(3);
  });
});

describe('filterPackages installed view', () => {
  it('keeps what is on disk even once its payload stops being offered', () => {
    const items = [
      item({ id: 'a', installed: true, available: false, unlisted: true }),
      item({ id: 'b' }),
    ];
    expect(filterPackages(items, 'installed', '').map((i) => i.id)).toEqual(['a']);
  });
});
