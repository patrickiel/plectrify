import { describe, expect, it } from 'vitest';
import {
  describeSystemUpdater,
  describeUpdateChannel,
  IDLE_UPDATE_CHANNEL,
  judgeUpdateChannel,
  reduceUpdateChannelState,
  type UpdateChannelState,
} from './updateChannel';

const probed = (over: Partial<UpdateChannelState> = {}): UpdateChannelState => ({
  ...IDLE_UPDATE_CHANNEL,
  probed: true,
  updater: 'update-manager',
  candidate: '0.1.8',
  sourceInstalled: true,
  canRefresh: true,
  ...over,
});

describe('reduceUpdateChannelState', () => {
  it('reads a whole engine push', () => {
    const next = reduceUpdateChannelState(IDLE_UPDATE_CHANNEL, {
      probed: true,
      updater: 'gnome-software',
      candidate: '0.1.9',
      sourceInstalled: true,
      canRefresh: true,
      refresh: 'done',
    });
    expect(next).toEqual(
      probed({ updater: 'gnome-software', candidate: '0.1.9', refresh: 'done' }),
    );
  });

  it('keeps the previous state when the refresh phase is unreadable', () => {
    const previous = probed({ refresh: 'refreshing' });
    expect(reduceUpdateChannelState(previous, { refresh: 'exploding' })).toBe(previous);
    expect(reduceUpdateChannelState(previous, null)).toBe(previous);
  });

  it('reports an updater this build cannot label as none', () => {
    // A newer engine that learnt a fourth updater: no button rather than a
    // button that says "Open Software Updater" and starts something else.
    const next = reduceUpdateChannelState(IDLE_UPDATE_CHANNEL, {
      probed: true,
      updater: 'cosmic-store',
      refresh: 'idle',
    });
    expect(next.updater).toBe('');
    expect(next.sourceInstalled).toBe(false);
    expect(next.canRefresh).toBe(false);
  });
});

describe('judgeUpdateChannel', () => {
  it('knows nothing before a probe has answered', () => {
    expect(judgeUpdateChannel('0.1.9', IDLE_UPDATE_CHANNEL)).toBe('unknown');
  });

  it('is ready when the index already offers the release', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.9' }))).toBe('ready');
    // Or something past it — GitHub's "latest" is never ahead of a promoted
    // repository, but the comparison must not care which way round.
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.10' }))).toBe('ready');
  });

  it('is pending while the index is behind and nothing has been tried', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.8' }))).toBe('pending');
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '' }))).toBe('pending');
    // A dismissed password prompt is "not now": back to the offer.
    expect(judgeUpdateChannel('0.1.9', probed({ refresh: 'declined' }))).toBe('pending');
    // A candidate in a shape that cannot be compared is not evidence either way.
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.9~rc1' }))).toBe('pending');
  });

  it('follows the refresh', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ refresh: 'refreshing' }))).toBe('refreshing');
    expect(judgeUpdateChannel('0.1.9', probed({ refresh: 'failed' }))).toBe('refreshFailed');
  });

  it('diagnoses a source that cannot see the release', () => {
    // The proof is a refresh that succeeded and still found nothing newer:
    // the index is fresh, so the source itself is what is out of date.
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.8', refresh: 'done' }))).toBe(
      'sourceStale',
    );
    // …unless it did find it, in which case the refresh was the whole fix.
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.9', refresh: 'done' }))).toBe(
      'ready',
    );
  });

  it('notices a removed sources entry before anything else', () => {
    expect(
      judgeUpdateChannel('0.1.9', probed({ sourceInstalled: false, candidate: '0.1.9' })),
    ).toBe('sourceMissing');
    // But not over a refresh in flight, whose answer is about to replace this.
    expect(
      judgeUpdateChannel('0.1.9', probed({ sourceInstalled: false, refresh: 'refreshing' })),
    ).toBe('refreshing');
  });
});

describe('wording', () => {
  it('names the updater as its desktop does', () => {
    expect(describeSystemUpdater('update-manager')).toBe('Software Updater');
    expect(describeSystemUpdater('gnome-software')).toBe('Software');
    expect(describeSystemUpdater('plasma-discover')).toBe('Discover');
    // None found: the generic line still has to name something to open.
    expect(describeSystemUpdater('')).toBe('Software Updater');
  });

  it('never names the file format or sends a Linux user to a .deb for a working source', () => {
    for (const verdict of ['unknown', 'ready', 'pending', 'refreshing'] as const) {
      const { text, command } = describeUpdateChannel(verdict, '0.1.9', 'plasma-discover');
      expect(`${text} ${command ?? ''}`).not.toMatch(/download|\.deb/i);
    }
    expect(describeUpdateChannel('ready', '0.1.9', 'plasma-discover').text).toContain('Discover');
    expect(describeUpdateChannel('pending', '0.1.9', '').command).toBe('sudo apt update');
    expect(describeUpdateChannel('ready', '0.1.9', '').command).toBe('sudo apt upgrade');
  });

  it('asks a failed refresh to try again first, with the download as the last resort', () => {
    // A failed fetch is also what a rotated key looks like, so the download is
    // named — but after the retry and the terminal, never instead of them.
    const { text, command } = describeUpdateChannel('refreshFailed', '0.1.9', '');
    expect(text).toMatch(/try again/i);
    expect(command).toBe('sudo apt update');
    expect(text.search(/try again/i)).toBeLessThan(text.search(/download/i));
    expect(text).not.toMatch(/\.deb/i);
  });

  it('sends a broken source to the download, naming the release', () => {
    expect(describeUpdateChannel('sourceStale', '0.1.9', '').text).toMatch(/0\.1\.9.*download/i);
    expect(describeUpdateChannel('sourceMissing', '0.1.9', '').text).toMatch(/download/i);
  });
});
