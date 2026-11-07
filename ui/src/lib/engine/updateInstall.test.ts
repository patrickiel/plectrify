import { describe, expect, it } from 'vitest';
import {
  describeUpdateInstallError,
  describeUpdateInstallPhase,
  formatDownloadProgress,
  IDLE_UPDATE_INSTALL,
  isUpdateInstallBusy,
  reduceUpdateInstallState,
  type UpdateInstallState,
} from './updateInstall';

const state = (over: Partial<UpdateInstallState> = {}): UpdateInstallState => ({
  ...IDLE_UPDATE_INSTALL,
  ...over,
});

describe('reduceUpdateInstallState', () => {
  it('reads a whole engine push', () => {
    const next = reduceUpdateInstallState(IDLE_UPDATE_INSTALL, {
      phase: 'downloading',
      version: '0.1.9',
      receivedBytes: 12_000_000,
      totalBytes: 37_574_188,
      error: '',
    });

    expect(next.phase).toBe('downloading');
    expect(next.version).toBe('0.1.9');
    expect(next.receivedBytes).toBe(12_000_000);
    expect(next.totalBytes).toBe(37_574_188);
    // An empty error is no error — the engine always sends the key.
    expect(next.error).toBeUndefined();
  });

  it('keeps the previous state when the phase is unreadable', () => {
    const previous = state({ phase: 'downloading', version: '0.1.9', totalBytes: 10 });

    // A push the bridge mangled, or one from an engine that grew a phase this
    // build has never heard of. Blanking would make a download in flight look
    // like it never started.
    expect(reduceUpdateInstallState(previous, { phase: 'reticulating' })).toBe(previous);
    expect(reduceUpdateInstallState(previous, {})).toBe(previous);
    expect(reduceUpdateInstallState(previous, null)).toBe(previous);
  });

  it('treats nonsense counts as zero', () => {
    const next = reduceUpdateInstallState(IDLE_UPDATE_INSTALL, {
      phase: 'downloading',
      receivedBytes: -5,
      totalBytes: 'lots',
    });
    expect(next.receivedBytes).toBe(0);
    expect(next.totalBytes).toBe(0);
  });

  it('carries the error token on a failure', () => {
    const next = reduceUpdateInstallState(IDLE_UPDATE_INSTALL, {
      phase: 'failed',
      error: 'checksum',
    });
    expect(next.phase).toBe('failed');
    expect(next.error).toBe('checksum');
  });
});

describe('isUpdateInstallBusy', () => {
  it('is busy from the first push to the last', () => {
    for (const phase of ['downloading', 'verifying', 'launching', 'installing'] as const)
      expect(isUpdateInstallBusy(state({ phase }))).toBe(true);
    expect(isUpdateInstallBusy(state({ phase: 'idle' }))).toBe(false);
    expect(isUpdateInstallBusy(state({ phase: 'failed', error: 'network' }))).toBe(false);
  });
});

describe('describeUpdateInstallPhase', () => {
  it('counts the download in whole megabytes once the size is known', () => {
    expect(
      describeUpdateInstallPhase(
        state({ phase: 'downloading', receivedBytes: 12_582_912, totalBytes: 38_797_312 }),
      ),
    ).toBe('Downloading 12 of 37 MB…');
    expect(describeUpdateInstallPhase(state({ phase: 'downloading' }))).toBe('Downloading…');
  });

  it('says the app is about to close only once the prompt is through', () => {
    expect(describeUpdateInstallPhase(state({ phase: 'launching' }))).toMatch(/Windows/);
    expect(describeUpdateInstallPhase(state({ phase: 'installing' }))).toMatch(/close and reopen/);
    expect(describeUpdateInstallPhase(state({ phase: 'idle' }))).toBe('');
  });
});

describe('formatDownloadProgress', () => {
  it('never shows more received than total', () => {
    expect(formatDownloadProgress(50_000_000, 38_797_312)).toBe('37 of 37 MB');
  });
});

describe('describeUpdateInstallError', () => {
  it('has a sentence for every token the engine sends', () => {
    for (const token of [
      'pluginInUse',
      'busy',
      'network',
      'manifest',
      'notNewer',
      'disk',
      'tooLarge',
      'truncated',
      'checksum',
      'launch',
      'unsupported',
    ]) {
      const text = describeUpdateInstallError(token);
      expect(text).not.toBe(token);
      expect(text.length).toBeGreaterThan(20);
    }
  });

  it('names the other app for the plugin-in-use refusal', () => {
    expect(describeUpdateInstallError('pluginInUse')).toMatch(/Close that app/);
  });

  it('falls back to the token itself, or a generic line', () => {
    expect(describeUpdateInstallError('mystery')).toBe('mystery');
    expect(describeUpdateInstallError(undefined)).toBe('Something went wrong.');
  });

  it('never names the plugin format', () => {
    for (const token of ['pluginInUse', 'launch', 'checksum'])
      expect(describeUpdateInstallError(token).toLowerCase()).not.toContain('vst');
  });
});
