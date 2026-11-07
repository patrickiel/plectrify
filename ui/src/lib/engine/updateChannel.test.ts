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
  ...over,
});

describe('reduceUpdateChannelState', () => {
  it('reads a whole engine push', () => {
    const next = reduceUpdateChannelState(IDLE_UPDATE_CHANNEL, {
      probed: true,
      updater: 'gnome-software',
      candidate: '0.1.9',
      sourceInstalled: true,
    });
    expect(next).toEqual(probed({ updater: 'gnome-software', candidate: '0.1.9' }));
  });

  it('keeps the previous state when the push is not an object', () => {
    const previous = probed();
    expect(reduceUpdateChannelState(previous, null)).toBe(previous);
    expect(reduceUpdateChannelState(previous, 'exploding')).toBe(previous);
  });

  it('reports an updater this build cannot label as none', () => {
    // A newer engine that learnt a fourth updater: no button rather than a
    // button that says "Open Software Updater" and starts something else.
    const next = reduceUpdateChannelState(IDLE_UPDATE_CHANNEL, {
      probed: true,
      updater: 'cosmic-store',
    });
    expect(next.updater).toBe('');
    expect(next.sourceInstalled).toBe(false);
  });
});

describe('judgeUpdateChannel', () => {
  it('knows nothing before a probe has answered', () => {
    expect(judgeUpdateChannel('0.1.9', IDLE_UPDATE_CHANNEL)).toBe('unknown');
  });

  it('is ready once the index offers the release or something past it', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.9' }))).toBe('ready');
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.2.0' }))).toBe('ready');
  });

  it('is pending while the index is behind', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.8' }))).toBe('pending');
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '' }))).toBe('pending');
    // A candidate this cannot compare is not evidence either way.
    expect(judgeUpdateChannel('0.1.9', probed({ candidate: '0.1.9~rc1' }))).toBe('pending');
  });

  it('puts a missing source before everything else', () => {
    expect(judgeUpdateChannel('0.1.9', probed({ sourceInstalled: false }))).toBe('sourceMissing');
    expect(
      judgeUpdateChannel('0.1.9', probed({ sourceInstalled: false, candidate: '0.1.9' })),
    ).toBe('sourceMissing');
  });
});

describe('describeUpdateChannel', () => {
  it('names the updater the desktop has', () => {
    expect(describeSystemUpdater('update-manager')).toBe('Software Updater');
    expect(describeSystemUpdater('gnome-software')).toBe('Software');
    expect(describeSystemUpdater('plasma-discover')).toBe('Discover');
    expect(describeSystemUpdater('')).toBe('Software Updater');
    expect(describeUpdateChannel('ready', '0.1.9', 'plasma-discover').text).toContain('Discover');
  });

  it('gives the terminal command wherever one applies', () => {
    expect(describeUpdateChannel('ready', '0.1.9', '').command).toBe('sudo apt upgrade');
    expect(describeUpdateChannel('pending', '0.1.9', '').command).toBe(
      'sudo apt update && sudo apt upgrade',
    );
    expect(describeUpdateChannel('unknown', '0.1.9', '').command).toBe(
      'sudo apt update && sudo apt upgrade',
    );
    expect(describeUpdateChannel('sourceMissing', '0.1.9', '').command).toBeUndefined();
  });

  it('sends a missing source to the download', () => {
    expect(describeUpdateChannel('sourceMissing', '0.1.9', '').text).toMatch(/download/i);
  });

  it('never mentions a Refresh the app does not offer', () => {
    for (const verdict of ['unknown', 'ready', 'pending', 'sourceMissing'] as const) {
      expect(describeUpdateChannel(verdict, '0.1.9', '').text).not.toMatch(/refresh/i);
    }
  });
});
