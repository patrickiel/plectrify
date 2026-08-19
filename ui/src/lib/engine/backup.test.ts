import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  describeBackupError,
  describeRestoreOutcome,
  IDLE_BACKUP,
  platformSlug,
  reduceBackupState,
  type BackupState,
} from './backup';

const state = (over: Partial<BackupState> = {}): BackupState => ({ ...IDLE_BACKUP, ...over });

describe('reduceBackupState', () => {
  it('reads a whole engine push', () => {
    const next = reduceBackupState(IDLE_BACKUP, {
      action: 'restore',
      phase: 'done',
      path: 'C:\\Users\\p\\Documents\\Plectrify backup 2026-08-19.plectrifybackup',
      platform: 'windows-x64',
      counts: { rigs: 3, patches: 7 },
      error: '',
    });

    expect(next.action).toBe('restore');
    expect(next.phase).toBe('done');
    expect(next.counts).toEqual({ rigs: 3, patches: 7 });
    expect(next.platform).toBe('windows-x64');
    // An empty error is no error — the engine always sends the key.
    expect(next.error).toBeUndefined();
  });

  it('keeps the previous state when the phase is unreadable', () => {
    const previous = state({ phase: 'working', action: 'restore' });

    // A push the bridge mangled, or one from an engine that grew a phase this
    // build has never heard of. Blanking the panel would be worse than
    // ignoring it: a restore in flight would look finished.
    expect(reduceBackupState(previous, { phase: 'reticulating' })).toBe(previous);
    expect(reduceBackupState(previous, {})).toBe(previous);
    expect(reduceBackupState(previous, null)).toBe(previous);
    expect(reduceBackupState(previous, 'nonsense')).toBe(previous);
  });

  it('defaults an unknown action to backup and coerces bad counts', () => {
    const next = reduceBackupState(IDLE_BACKUP, {
      phase: 'failed',
      action: 'something-else',
      counts: { rigs: -1, patches: 'many' },
      error: 'damaged',
    });

    expect(next.action).toBe('backup');
    expect(next.counts).toEqual({ rigs: 0, patches: 0 });
    expect(next.error).toBe('damaged');
  });

  it('carries no counts when the engine sends none', () => {
    expect(reduceBackupState(IDLE_BACKUP, { phase: 'cancelled' }).counts).toEqual({
      rigs: 0,
      patches: 0,
    });
  });
});

describe('describeBackupError', () => {
  it('words every token the engine sends', () => {
    for (const token of [
      'empty',
      'write',
      'save',
      'notBackup',
      'newerFormat',
      'dataRoot',
      'damaged',
    ]) {
      const text = describeBackupError(token);
      expect(text).not.toBe(token);
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it('falls back to the raw token, then to something', () => {
    expect(describeBackupError('a brand new failure')).toBe('a brand new failure');
    expect(describeBackupError(undefined)).toBe('Something went wrong.');
  });
});

describe('describeRestoreOutcome', () => {
  const restored = (over: Partial<BackupState>) => state({ action: 'restore', ...over });

  it('counts what arrived, with singular and plural', () => {
    expect(
      describeRestoreOutcome(restored({ counts: { rigs: 3, patches: 7 } }), 'windows-x64'),
    ).toBe('Restored 3 rigs and 7 patches.');
    expect(
      describeRestoreOutcome(restored({ counts: { rigs: 1, patches: 1 } }), 'windows-x64'),
    ).toBe('Restored 1 rig and 1 patch.');
    expect(
      describeRestoreOutcome(restored({ counts: { rigs: 0, patches: 0 } }), 'windows-x64'),
    ).toBe('Restored 0 rigs and 0 patches.');
  });

  it('warns when the archive came from the other operating system', () => {
    const text = describeRestoreOutcome(
      restored({ counts: { rigs: 1, patches: 2 }, platform: 'macos-arm64' }),
      'windows-x64',
    );
    expect(text).toContain('another operating system');
  });

  it('stays quiet when the platforms match, or when either is unknown', () => {
    const same = describeRestoreOutcome(restored({ platform: 'windows-x64' }), 'windows-x64');
    expect(same).not.toContain('another operating system');

    // An engine that recorded no platform, or a page that does not know its
    // own: a guess either way would be a warning the user cannot act on.
    expect(describeRestoreOutcome(restored({ platform: '' }), 'windows-x64')).not.toContain(
      'another operating system',
    );
    expect(describeRestoreOutcome(restored({ platform: 'macos-arm64' }), '')).not.toContain(
      'another operating system',
    );
  });
});

describe('backupFileName', () => {
  it('keeps only the name, whichever separator the OS used', () => {
    expect(backupFileName('C:\\Users\\p\\Documents\\rigs.plectrifybackup')).toBe(
      'rigs.plectrifybackup',
    );
    expect(backupFileName('/Users/p/Documents/rigs.plectrifybackup')).toBe('rigs.plectrifybackup');
  });

  it('passes through a bare name, and never returns nothing', () => {
    expect(backupFileName('rigs.plectrifybackup')).toBe('rigs.plectrifybackup');
    expect(backupFileName('')).toBe('');
  });
});

describe('platformSlug', () => {
  it('maps the page view of the OS onto the archive slug', () => {
    expect(platformSlug('windows')).toBe('windows-x64');
    expect(platformSlug('macos')).toBe('macos-arm64');
    // An engine older than AppInfo.platform: no slug, so no comparison.
    expect(platformSlug(undefined)).toBe('');
  });
});
