import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  MAX_RACK_ZOOM,
  MAX_UI_SCALE,
  MIN_RACK_ZOOM,
  MIN_UI_SCALE,
  normalizeAppSettings,
} from './appSettings';
import { uid } from './ids';

describe('normalizeAppSettings', () => {
  it('falls back to defaults for garbage input', () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings({})).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings({ rackZoom: 'abc' })).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings({ rackZoom: Infinity })).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('clamps zoom into the supported range', () => {
    expect(normalizeAppSettings({ rackZoom: 0.01 }).rackZoom).toBe(MIN_RACK_ZOOM);
    expect(normalizeAppSettings({ rackZoom: 99 }).rackZoom).toBe(MAX_RACK_ZOOM);
  });

  it('rounds to the 0.05 step grid and accepts numeric strings', () => {
    expect(normalizeAppSettings({ rackZoom: 1.23 }).rackZoom).toBe(1.25);
    expect(normalizeAppSettings({ rackZoom: 1.25 }).rackZoom).toBe(1.25);
    expect(normalizeAppSettings({ rackZoom: '1.2' as unknown as number }).rackZoom).toBe(1.2);
  });

  it('clamps the interface scale into its own, narrower range', () => {
    expect(normalizeAppSettings({ uiScale: 0.1 }).uiScale).toBe(MIN_UI_SCALE);
    expect(normalizeAppSettings({ uiScale: 3 }).uiScale).toBe(MAX_UI_SCALE);
    expect(normalizeAppSettings({ uiScale: 1.23 }).uiScale).toBe(1.25);
    expect(normalizeAppSettings({ uiScale: 'big' }).uiScale).toBe(1);
    expect(normalizeAppSettings({}).uiScale).toBe(1);
  });

  it('keeps the selected rack mode and defaults malformed values to Perform', () => {
    expect(normalizeAppSettings({ editMode: true }).editMode).toBe(true);
    expect(normalizeAppSettings({ editMode: false }).editMode).toBe(false);
    expect(normalizeAppSettings({ editMode: 'edit' }).editMode).toBe(false);
    expect(normalizeAppSettings({}).editMode).toBe(false);
  });

  it('keeps the persisted rig selection and drops non-string values', () => {
    expect(normalizeAppSettings({ activeRigId: 'rig-7' }).activeRigId).toBe('rig-7');
    expect(normalizeAppSettings({ activeRigId: 42 }).activeRigId).toBe('');
    expect(normalizeAppSettings({}).activeRigId).toBe('');
  });

  it('keeps the persisted drawer section and drops non-string values', () => {
    expect(normalizeAppSettings({ drawerOpenSection: 'plugins:CHOWDSP' }).drawerOpenSection).toBe(
      'plugins:CHOWDSP',
    );
    expect(normalizeAppSettings({ drawerOpenSection: 7 }).drawerOpenSection).toBe('');
    expect(normalizeAppSettings({}).drawerOpenSection).toBe('');
  });

  it('keeps a dismissed update version and drops non-string values', () => {
    expect(normalizeAppSettings({ updateDismissedVersion: '0.2.0' }).updateDismissedVersion).toBe(
      '0.2.0',
    );
    expect(
      normalizeAppSettings({ updateDismissedVersion: 2 as unknown as string })
        .updateDismissedVersion,
    ).toBe('');
    expect(normalizeAppSettings({}).updateDismissedVersion).toBe('');
  });

  it('keeps well-formed per-rig scene entries and drops the rest', () => {
    expect(
      normalizeAppSettings({ lastSceneByRig: { 'rig-1': 'scene-2', 'rig-2': 7 } }).lastSceneByRig,
    ).toEqual({ 'rig-1': 'scene-2' });
    expect(normalizeAppSettings({ lastSceneByRig: ['scene-2'] }).lastSceneByRig).toEqual({});
    expect(normalizeAppSettings({}).lastSceneByRig).toEqual({});
  });

  it('keeps a known theme and falls back to dark for anything else', () => {
    expect(normalizeAppSettings({ theme: 'light' }).theme).toBe('light');
    expect(normalizeAppSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(normalizeAppSettings({ theme: 'sepia' }).theme).toBe('dark');
    expect(normalizeAppSettings({ theme: 7 }).theme).toBe('dark');
    expect(normalizeAppSettings({}).theme).toBe('dark');
  });

  it('keeps a known tuner readout and falls back to the needle for anything else', () => {
    expect(normalizeAppSettings({ tunerDisplay: 'strobe' }).tunerDisplay).toBe('strobe');
    expect(normalizeAppSettings({ tunerDisplay: 'needle' }).tunerDisplay).toBe('needle');
    // 'poly' was once offered; a stale settings file asking for it falls back.
    expect(normalizeAppSettings({ tunerDisplay: 'poly' }).tunerDisplay).toBe('needle');
    expect(normalizeAppSettings({ tunerDisplay: 'disc' }).tunerDisplay).toBe('needle');
    expect(normalizeAppSettings({ tunerDisplay: true }).tunerDisplay).toBe('needle');
    expect(normalizeAppSettings({}).tunerDisplay).toBe('needle');
  });

  it('keeps an offered strobe precision and falls back to x2 for anything else', () => {
    expect(normalizeAppSettings({ tunerStrobePrecision: 1 }).tunerStrobePrecision).toBe(1);
    expect(normalizeAppSettings({ tunerStrobePrecision: 4 }).tunerStrobePrecision).toBe(4);
    // 8 was once offered; a stale settings file asking for it falls back.
    expect(normalizeAppSettings({ tunerStrobePrecision: 8 }).tunerStrobePrecision).toBe(2);
    // 12 is a plausible-looking multiplier the display never offers.
    expect(normalizeAppSettings({ tunerStrobePrecision: 12 }).tunerStrobePrecision).toBe(2);
    expect(normalizeAppSettings({ tunerStrobePrecision: '4' }).tunerStrobePrecision).toBe(2);
    expect(normalizeAppSettings({}).tunerStrobePrecision).toBe(2);
  });

  it('keeps an offered needle precision and falls back to x2 for anything else', () => {
    expect(normalizeAppSettings({ tunerNeedlePrecision: 1 }).tunerNeedlePrecision).toBe(1);
    expect(normalizeAppSettings({ tunerNeedlePrecision: 4 }).tunerNeedlePrecision).toBe(4);
    // A plausible-looking magnification the scale never offers.
    expect(normalizeAppSettings({ tunerNeedlePrecision: 3 }).tunerNeedlePrecision).toBe(2);
    expect(normalizeAppSettings({ tunerNeedlePrecision: '4' }).tunerNeedlePrecision).toBe(2);
    expect(normalizeAppSettings({}).tunerNeedlePrecision).toBe(2);
  });

  it('leaves Auto Standby off unless it was explicitly enabled', () => {
    expect(normalizeAppSettings({}).standbyEnabled).toBe(false);
    expect(normalizeAppSettings({ standbyEnabled: 'yes' }).standbyEnabled).toBe(false);
    expect(normalizeAppSettings({ standbyEnabled: true }).standbyEnabled).toBe(true);
    expect(normalizeAppSettings({ standbyEnabled: false }).standbyEnabled).toBe(false);
  });

  it('keeps offered standby delays and falls back for anything else', () => {
    expect(normalizeAppSettings({ standbyLightAfterMinutes: 20 }).standbyLightAfterMinutes).toBe(
      20,
    );
    // A hand-edited file must not be able to ask for a near-instant timeout.
    expect(normalizeAppSettings({ standbyLightAfterMinutes: 0.01 }).standbyLightAfterMinutes).toBe(
      10,
    );
    expect(normalizeAppSettings({ standbyLightAfterMinutes: '5' }).standbyLightAfterMinutes).toBe(
      10,
    );
    expect(normalizeAppSettings({}).standbyLightAfterMinutes).toBe(10);
  });

  it('treats a zero deep-standby delay as the real "never" value', () => {
    expect(normalizeAppSettings({}).standbyDeepAfterMinutes).toBe(0);
    expect(normalizeAppSettings({ standbyDeepAfterMinutes: 0 }).standbyDeepAfterMinutes).toBe(0);
    expect(normalizeAppSettings({ standbyDeepAfterMinutes: 30 }).standbyDeepAfterMinutes).toBe(30);
    expect(normalizeAppSettings({ standbyDeepAfterMinutes: 7 }).standbyDeepAfterMinutes).toBe(0);
  });

  it('keeps an offered wake threshold and falls back to the default', () => {
    expect(normalizeAppSettings({ standbyWakeThresholdDb: -40 }).standbyWakeThresholdDb).toBe(-40);
    expect(normalizeAppSettings({ standbyWakeThresholdDb: 12 }).standbyWakeThresholdDb).toBe(-50);
    expect(normalizeAppSettings({}).standbyWakeThresholdDb).toBe(-50);
  });

  it('normalizes looper session cleanup preferences', () => {
    expect(normalizeAppSettings({}).looperSessionAutoCleanup).toBe(true);
    expect(normalizeAppSettings({ looperSessionAutoCleanup: false }).looperSessionAutoCleanup).toBe(
      false,
    );
    expect(
      normalizeAppSettings({ looperSessionAutoCleanupLimit: 7.6 }).looperSessionAutoCleanupLimit,
    ).toBe(8);
    expect(
      normalizeAppSettings({ looperSessionAutoCleanupLimit: 0 }).looperSessionAutoCleanupLimit,
    ).toBe(1);
    expect(
      normalizeAppSettings({ looperSessionAutoCleanupLimit: 5000 }).looperSessionAutoCleanupLimit,
    ).toBe(999);
    expect(
      normalizeAppSettings({ looperSessionAutoCleanupLimit: 'many' }).looperSessionAutoCleanupLimit,
    ).toBe(20);
  });

  it('keeps a known looper view and defaults malformed values to Simple', () => {
    expect(normalizeAppSettings({}).looperViewMode).toBe('simple');
    expect(normalizeAppSettings({ looperViewMode: 'expert' }).looperViewMode).toBe('expert');
    expect(normalizeAppSettings({ looperViewMode: 'advanced' }).looperViewMode).toBe('simple');
  });

  it('keeps a known metronome view and defaults malformed values to Simple', () => {
    expect(normalizeAppSettings({}).metronomeViewMode).toBe('simple');
    expect(normalizeAppSettings({ metronomeViewMode: 'expert' }).metronomeViewMode).toBe('expert');
    expect(normalizeAppSettings({ metronomeViewMode: false }).metronomeViewMode).toBe('simple');
  });

  it('keeps the song tool mode and defaults malformed values to Perform', () => {
    expect(normalizeAppSettings({ songEditMode: true }).songEditMode).toBe(true);
    expect(normalizeAppSettings({ songEditMode: 'edit' }).songEditMode).toBe(false);
    expect(normalizeAppSettings({}).songEditMode).toBe(false);
  });

  it('drops a malformed MIDI binding map wholesale', () => {
    expect(normalizeAppSettings({}).midiBindings).toEqual({});
    expect(normalizeAppSettings({ midiBindings: 'cc25' }).midiBindings).toEqual({});
    expect(normalizeAppSettings({ midiBindings: [{ type: 'cc' }] }).midiBindings).toEqual({});
  });

  it('keeps well-formed MIDI bindings and drops malformed entries individually', () => {
    const good = { type: 'cc', channel: 1, number: 25 };
    const settings = normalizeAppSettings({
      midiBindings: {
        'rig:0': good,
        tunerToggle: { type: 'note', channel: 16, number: 127 },
        metronomeToggle: { type: 'pc', channel: 2, number: 8 },
        metronomeTapTempo: { type: 'cc', channel: 3, number: 9 },
        songNext: { type: 'cc', channel: 1, number: 80 },
        songBogus: good, // unknown verb in a known family
        sceneNext: { type: 'pc', channel: 0, number: 5 }, // channel below 1
        scenePrev: { type: 'cc', channel: 1, number: 128 }, // number above 127
        rigNext: { type: 'aftertouch', channel: 1, number: 3 }, // unknown kind
        'scene:banana': good, // malformed index key
        volumePedal: good, // unknown action
      },
    });
    expect(settings.midiBindings).toEqual({
      'rig:0': good,
      tunerToggle: { type: 'note', channel: 16, number: 127 },
      metronomeToggle: { type: 'pc', channel: 2, number: 8 },
      metronomeTapTempo: { type: 'cc', channel: 3, number: 9 },
      songNext: { type: 'cc', channel: 1, number: 80 },
    });
  });

  it('keeps a known active tool and drops unknown ids', () => {
    expect(normalizeAppSettings({ activeTool: 'looper' }).activeTool).toBe('looper');
    expect(normalizeAppSettings({ activeTool: 'metronome' }).activeTool).toBe('metronome');
    expect(normalizeAppSettings({ activeTool: 'setlist' }).activeTool).toBe('setlist');
    expect(normalizeAppSettings({ activeTool: 'info' }).activeTool).toBe('info');
    expect(normalizeAppSettings({ activeTool: 'settings' }).activeTool).toBe('settings');
    // A tool from a newer build (or garbage) falls back to a closed panel.
    expect(normalizeAppSettings({ activeTool: 'beatbox' }).activeTool).toBe(null);
    expect(normalizeAppSettings({ activeTool: 7 }).activeTool).toBe(null);
    expect(normalizeAppSettings({}).activeTool).toBe(null);
  });

  it('migrates the pre-rail toolsSidebarOpen boolean to the looper', () => {
    expect(normalizeAppSettings({ toolsSidebarOpen: true }).activeTool).toBe('looper');
    expect(normalizeAppSettings({ toolsSidebarOpen: false }).activeTool).toBe(null);
    // An explicit activeTool always wins over the stale key.
    expect(normalizeAppSettings({ toolsSidebarOpen: true, activeTool: 'looper' }).activeTool).toBe(
      'looper',
    );
  });

  it('validates the song library before the setlists that reference it', () => {
    const settings = normalizeAppSettings({
      songs: [
        { id: 'a', name: 'Opener' },
        { id: 'b' }, // no name — dropped
      ],
      setlists: [{ id: 'l', name: 'Friday', songIds: ['a', 'b'] }],
    });
    expect(settings.songs.map((s) => s.id)).toEqual(['a']);
    // 'b' never reached the library, so the set can't still point at it.
    expect(settings.setlists[0].songIds).toEqual(['a']);
  });

  it('clears selections whose target did not survive normalization', () => {
    const settings = normalizeAppSettings({
      songs: [{ id: 'a', name: 'Opener' }],
      setlists: [{ id: 'l', name: 'Friday', songIds: ['a'] }],
      activeSetlistId: 'l',
      activeSongId: 'deleted',
    });
    expect(settings.activeSetlistId).toBe('l');
    expect(settings.activeSongId).toBe('');
    const orphaned = normalizeAppSettings({ activeSetlistId: 'l', activeSongId: 'a' });
    expect(orphaned.activeSetlistId).toBe('');
    expect(orphaned.activeSongId).toBe('');
  });

  it('strips stray extra properties from a stored MIDI trigger', () => {
    const settings = normalizeAppSettings({
      midiBindings: { 'rig:0': { type: 'cc', channel: 1, number: 25, value: 127, label: 'x' } },
    });
    expect(settings.midiBindings['rig:0']).toEqual({ type: 'cc', channel: 1, number: 25 });
  });
});

describe('uid', () => {
  it('prefixes and never repeats', () => {
    const a = uid('mod');
    const b = uid('mod');
    expect(a.startsWith('mod-')).toBe(true);
    expect(a).not.toBe(b);
  });
});
