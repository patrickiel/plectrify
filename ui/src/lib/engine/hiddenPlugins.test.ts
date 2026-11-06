import { describe, expect, it } from 'vitest';
import { normalizeAppSettings } from './appSettings';
import {
  hidePlugin,
  hidePluginDragData,
  normalizeHiddenPlugins,
  parseHidePluginDrag,
  showPlugin,
  visiblePlugins,
} from './hiddenPlugins';
import type { PluginInfo } from './types';

const drums: PluginInfo = { id: 'VST3-Drums-aaa-1', name: 'Drums', manufacturer: 'Acme' };
const amp: PluginInfo = { id: 'VST3-Amp-bbb-2', name: 'Amp', format: 'vst3' };
const legacyAmp: PluginInfo = { id: 'VST-Amp-ccc-3', name: 'Amp', format: 'legacy' };

describe('normalizeHiddenPlugins', () => {
  it('reads anything that is not a list as nothing hidden', () => {
    expect(normalizeHiddenPlugins(undefined)).toEqual([]);
    expect(normalizeHiddenPlugins('Drums')).toEqual([]);
    expect(normalizeHiddenPlugins({ name: 'Drums' })).toEqual([]);
  });

  it('drops malformed entries and rebuilds the rest field by field', () => {
    expect(
      normalizeHiddenPlugins([
        null,
        7,
        {},
        { name: '' },
        { name: 3 },
        { name: 'Drums', format: 'vst3', id: 'stray' },
      ]),
    ).toEqual([{ name: 'Drums', format: 'vst3' }]);
  });

  it('reads an absent or unknown format as VST3', () => {
    expect(normalizeHiddenPlugins([{ name: 'A' }, { name: 'B', format: 'clap' }])).toEqual([
      { name: 'A', format: 'vst3' },
      { name: 'B', format: 'vst3' },
    ]);
  });

  it('keeps one entry per identity, and sorts by name', () => {
    expect(
      normalizeHiddenPlugins([
        { name: 'Zed' },
        { name: 'Amp', format: 'vst3' },
        { name: 'Amp', format: 'legacy' },
        { name: 'Amp' },
      ]),
    ).toEqual([
      { name: 'Amp', format: 'legacy' },
      { name: 'Amp', format: 'vst3' },
      { name: 'Zed', format: 'vst3' },
    ]);
  });

  it('is what the settings file is read through, and nothing is hidden by default', () => {
    expect(normalizeAppSettings({}).hiddenPlugins).toEqual([]);
    expect(normalizeAppSettings({ hiddenPlugins: [{ name: 'Drums' }] }).hiddenPlugins).toEqual([
      { name: 'Drums', format: 'vst3' },
    ]);
  });
});

describe('hidePlugin and showPlugin', () => {
  it('stores the identity, not the id', () => {
    expect(hidePlugin([], drums)).toEqual([{ name: 'Drums', format: 'vst3' }]);
  });

  it('does not list a plugin twice', () => {
    expect(hidePlugin(hidePlugin([], drums), drums)).toHaveLength(1);
  });

  it('brings back only the format asked for', () => {
    const hidden = hidePlugin(hidePlugin([], amp), legacyAmp);
    expect(showPlugin(hidden, { name: 'Amp', format: 'legacy' })).toEqual([
      { name: 'Amp', format: 'vst3' },
    ]);
  });

  it('leaves the list alone for a plugin that is not on it', () => {
    const hidden = hidePlugin([], drums);
    expect(showPlugin(hidden, { name: 'Amp', format: 'vst3' })).toEqual(hidden);
  });
});

describe('the hide drag payload', () => {
  it('round-trips the identity and nothing else', () => {
    expect(parseHidePluginDrag(hidePluginDragData(legacyAmp))).toEqual({
      name: 'Amp',
      format: 'legacy',
    });
    expect(parseHidePluginDrag(hidePluginDragData(drums))).toEqual({
      name: 'Drums',
      format: 'vst3',
    });
  });

  it('reads anything malformed as nothing to hide', () => {
    expect(parseHidePluginDrag('')).toBeNull();
    expect(parseHidePluginDrag('not json')).toBeNull();
    expect(parseHidePluginDrag('null')).toBeNull();
    expect(parseHidePluginDrag('{"name":""}')).toBeNull();
  });
});

describe('visiblePlugins', () => {
  it('leaves out a hidden plugin and keeps the rest', () => {
    expect(visiblePlugins([drums, amp], hidePlugin([], drums))).toEqual([amp]);
  });

  it('tells two plugins of one name apart by format', () => {
    expect(visiblePlugins([amp, legacyAmp], hidePlugin([], legacyAmp))).toEqual([amp]);
    expect(visiblePlugins([amp, legacyAmp], hidePlugin([], amp))).toEqual([legacyAmp]);
  });

  it('matches a plugin with no format as VST3', () => {
    expect(visiblePlugins([drums], [{ name: 'Drums', format: 'vst3' }])).toEqual([]);
  });

  it('survives a rescan that gives the plugin a new id', () => {
    const hidden = hidePlugin([], drums);
    const moved: PluginInfo = { ...drums, id: 'VST3-Drums-fff-1' };
    expect(visiblePlugins([moved], hidden)).toEqual([]);
  });

  it('ignores an entry whose plugin is no longer installed', () => {
    expect(visiblePlugins([amp], hidePlugin([], drums))).toEqual([amp]);
  });
});
