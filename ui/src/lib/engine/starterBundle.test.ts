import { describe, expect, it } from 'vitest';
import { decideStarterAutoInstall, STARTER_BUNDLE_ID } from './starterBundle';
import { EMPTY_CATALOGUE_STATE, type CataloguePackage, type CatalogueState } from './catalogue';
import { DEFAULT_APP_SETTINGS } from './appSettings';
import type { AppSettings } from './types';

function item(id: string, overrides: Partial<CataloguePackage> = {}): CataloguePackage {
  return {
    id,
    kind: 'plugin',
    category: ['Effects'],
    tags: [],
    name: id,
    purpose: '',
    version: '1',
    licenseId: 'MIT',
    licenseUrl: '',
    projectUrl: '',
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

/** A fresh machine's catalogue: the starter bundle, nothing installed. */
function state(items: CataloguePackage[], packageIds = items.map((i) => i.id)): CatalogueState {
  return {
    ...EMPTY_CATALOGUE_STATE,
    source: 'remote',
    items,
    bundles: [
      {
        id: STARTER_BUNDLE_ID,
        name: 'Starter bundle',
        description: '',
        version: '11',
        packageIds,
        missingPackageIds: packageIds,
        outdatedPackageIds: [],
        installedVersion: '',
        installed: false,
        updateAvailable: false,
      },
    ],
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ...overrides };
}

describe('decideStarterAutoInstall', () => {
  it('installs the bundle on a first run', () => {
    const decision = decideStarterAutoInstall(
      state([item('peakeater'), item('qdelay')]),
      settings(),
    );
    expect(decision).toEqual({ install: ['peakeater', 'qdelay'], markAttempted: true });
  });

  it('never asks again once attempted, however empty the machine is', () => {
    const decision = decideStarterAutoInstall(
      state([item('peakeater')]),
      settings({ starterInstallAttempted: true }),
    );
    expect(decision).toEqual({ install: [], markAttempted: false });
  });

  it('settles without installing when anything is already installed', () => {
    // A user of an older build who installed one plugin by hand: not a first
    // run, whatever settings.json is missing.
    const decision = decideStarterAutoInstall(
      state([item('peakeater', { installed: true, installedVersion: '1' }), item('qdelay')]),
      settings(),
    );
    expect(decision).toEqual({ install: [], markAttempted: true });
  });

  it('settles when the bundle itself is recorded as installed', () => {
    const base = state([item('peakeater')]);
    const catalogue = {
      ...base,
      bundles: [{ ...base.bundles[0], installedVersion: '11', installed: true }],
    };
    expect(decideStarterAutoInstall(catalogue, settings())).toEqual({
      install: [],
      markAttempted: true,
    });
  });

  it('leaves the question open when no catalogue could be read', () => {
    const offline: CatalogueState = { ...EMPTY_CATALOGUE_STATE, source: 'none' };
    expect(decideStarterAutoInstall(offline, settings())).toEqual({
      install: [],
      markAttempted: false,
    });
  });

  it('leaves the question open while a run is already going', () => {
    const busy = { ...state([item('peakeater')]), busy: true };
    expect(decideStarterAutoInstall(busy, settings())).toEqual({
      install: [],
      markAttempted: false,
    });
  });

  it('leaves the question open when the catalogue publishes no starter bundle', () => {
    const noBundle = { ...state([item('peakeater')]), bundles: [] };
    expect(decideStarterAutoInstall(noBundle, settings())).toEqual({
      install: [],
      markAttempted: false,
    });
  });

  it('skips members this platform is not offered', () => {
    // The bundle is one list of ids for every OS — macOS is offered two of the
    // five — so an unavailable member is dropped rather than queued to fail.
    const decision = decideStarterAutoInstall(
      state([item('peakeater', { available: false }), item('qdelay')]),
      settings(),
    );
    expect(decision).toEqual({ install: ['qdelay'], markAttempted: true });
  });

  it('ignores catalogue rows the bundle does not name', () => {
    const catalogue = state([item('peakeater'), item('some-other-plugin')], ['peakeater']);
    expect(decideStarterAutoInstall(catalogue, settings()).install).toEqual(['peakeater']);
  });

  it('settles rather than repeating when every member is unavailable here', () => {
    const decision = decideStarterAutoInstall(
      state([item('peakeater', { available: false })]),
      settings(),
    );
    expect(decision).toEqual({ install: [], markAttempted: true });
  });
});
