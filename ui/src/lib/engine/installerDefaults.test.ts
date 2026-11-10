import { describe, expect, it } from 'vitest';
import {
  applyInstallerDefaults,
  parseInstallerDefaults,
  settingsToStore,
} from './installerDefaults';
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from './appSettings';

describe('parseInstallerDefaults', () => {
  it('reads the two booleans from the JSON text the engine bakes in', () => {
    expect(parseInstallerDefaults('{"checkForUpdates":false,"starterInstall":true}')).toEqual({
      checkForUpdates: false,
      starterInstall: true,
    });
  });

  it('contributes nothing for anything it does not recognise', () => {
    expect(parseInstallerDefaults('{}')).toEqual({});
    expect(parseInstallerDefaults('not json')).toEqual({});
    expect(parseInstallerDefaults(undefined)).toEqual({});
    expect(parseInstallerDefaults('[true]')).toEqual({});
    expect(parseInstallerDefaults({ checkForUpdates: 'no', starterInstall: 0 })).toEqual({});
  });
});

describe('applyInstallerDefaults', () => {
  it('changes nothing when the installer asked nothing', () => {
    expect(applyInstallerDefaults(DEFAULT_APP_SETTINGS, null, {})).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('turns the update check off on a fresh machine', () => {
    const next = applyInstallerDefaults(DEFAULT_APP_SETTINGS, null, { checkForUpdates: false });
    expect(next.checkForUpdates).toBe(false);
  });

  it('turns it off for an upgrading user whose settings never answered', () => {
    const stored = { rackZoom: 1.2 };
    const next = applyInstallerDefaults(normalizeAppSettings(stored), stored, {
      checkForUpdates: false,
    });
    expect(next.checkForUpdates).toBe(false);
  });

  it('never overrides a choice the user made in the app', () => {
    const stored = { checkForUpdates: true };
    const next = applyInstallerDefaults(normalizeAppSettings(stored), stored, {
      checkForUpdates: false,
    });
    expect(next.checkForUpdates).toBe(true);
  });

  it('settles the starter install on a fresh machine when declined', () => {
    const next = applyInstallerDefaults(DEFAULT_APP_SETTINGS, null, { starterInstall: false });
    expect(next.starterInstallAttempted).toBe(true);
  });

  it('leaves the starter install owed when accepted or not asked', () => {
    expect(
      applyInstallerDefaults(DEFAULT_APP_SETTINGS, null, { starterInstall: true })
        .starterInstallAttempted,
    ).toBe(false);
    expect(applyInstallerDefaults(DEFAULT_APP_SETTINGS, null, {}).starterInstallAttempted).toBe(
      false,
    );
  });
});

describe('settingsToStore', () => {
  // One write of a setting, as persistAppSettings does it; returns the new disk.
  const write = (disk: object, changed: object, installer: object): object => {
    const source = { ...disk, ...changed };
    const settings = applyInstallerDefaults(normalizeAppSettings(source), source, installer);
    return JSON.parse(JSON.stringify(settingsToStore(settings, source))) as object;
  };

  it('does not store an answer the user never gave', () => {
    const disk = write({}, { rackZoom: 1.2 }, { checkForUpdates: true });
    expect(disk).not.toHaveProperty('checkForUpdates');
  });

  it('lets a reinstall with the box unticked take effect', () => {
    const disk = write({}, { rackZoom: 1.2 }, { checkForUpdates: true });
    const next = applyInstallerDefaults(normalizeAppSettings(disk), disk, {
      checkForUpdates: false,
    });
    expect(next.checkForUpdates).toBe(false);
  });

  it('stores the choice once the user makes it, and keeps it', () => {
    const disk = write({}, { checkForUpdates: true }, { checkForUpdates: false });
    expect(disk).toHaveProperty('checkForUpdates', true);
    const later = write(disk, { rackZoom: 1.2 }, { checkForUpdates: false });
    expect(later).toHaveProperty('checkForUpdates', true);
  });
});
