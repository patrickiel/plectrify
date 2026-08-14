import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLatestReleaseTag,
  hasUpdate,
  isNewerVersion,
  parseVersion,
  shouldOfferUpdate,
} from './updateCheck';

describe('parseVersion', () => {
  it('accepts MAJOR.MINOR.PATCH with or without the tag prefix', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('v0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('V1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30]);
    expect(parseVersion('  1.0.0  ')).toEqual([1, 0, 0]);
  });

  it('rejects anything it cannot compare', () => {
    for (const value of ['', 'dev', '1.2', '1.2.3.4', '0.2.0-rc1', 'nightly', '1.2.x']) {
      expect(parseVersion(value)).toBeNull();
    }
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not as strings', () => {
    // The load-bearing case: a string compare would put 0.9.0 above 0.10.0.
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('is false when either side is unparseable', () => {
    expect(isNewerVersion('0.2.0', 'dev')).toBe(false);
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '')).toBe(false);
  });
});

describe('hasUpdate', () => {
  it('reports a newer release regardless of any dismissal', () => {
    expect(hasUpdate('0.1.0', '0.2.0')).toBe(true);
    expect(hasUpdate('0.2.0', '0.2.0')).toBe(false);
  });

  it('stays quiet for a version it cannot compare', () => {
    // The mock reports 'dev', and a build with no comparable version must not
    // be told an older release is an upgrade.
    expect(hasUpdate('dev', '0.2.0')).toBe(false);
    expect(hasUpdate('', '0.2.0')).toBe(false);
  });
});

describe('shouldOfferUpdate', () => {
  it('offers a newer release that has not been dismissed', () => {
    expect(shouldOfferUpdate('0.1.0', '0.2.0', '')).toBe(true);
  });

  it('stays quiet about the exact release the user dismissed', () => {
    expect(shouldOfferUpdate('0.1.0', '0.2.0', '0.2.0')).toBe(false);
  });

  it('speaks up again when a release newer than the dismissed one appears', () => {
    // This is the whole point of storing the offered version rather than a
    // flag: dismissing 0.2.0 must not silence 0.3.0.
    expect(shouldOfferUpdate('0.1.0', '0.3.0', '0.2.0')).toBe(true);
  });

  it('is inert once the dismissed release is installed', () => {
    expect(shouldOfferUpdate('0.2.0', '0.2.0', '0.2.0')).toBe(false);
  });

  it('stays quiet when there is nothing to compare', () => {
    expect(shouldOfferUpdate('', '0.2.0', '')).toBe(false);
    expect(shouldOfferUpdate('dev', '0.2.0', '')).toBe(false);
    // A failed check leaves the latest version empty.
    expect(shouldOfferUpdate('0.1.0', '', '')).toBe(false);
  });
});

describe('fetchLatestReleaseTag', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: () => unknown) {
    vi.stubGlobal('fetch', vi.fn(impl));
  }

  it('returns the tag with the leading v stripped', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: 'v0.2.0' }) }),
    );
    await expect(fetchLatestReleaseTag()).resolves.toBe('0.2.0');
  });

  it('returns null when the body carries no usable tag', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    await expect(fetchLatestReleaseTag()).resolves.toBeNull();
  });

  it('returns null when GitHub refuses — rate limit, no release', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    await expect(fetchLatestReleaseTag()).resolves.toBeNull();
  });

  it('returns null when the request itself fails — offline', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchLatestReleaseTag()).resolves.toBeNull();
  });

  it('returns null when the response is not JSON', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('bad')) }),
    );
    await expect(fetchLatestReleaseTag()).resolves.toBeNull();
  });
});
