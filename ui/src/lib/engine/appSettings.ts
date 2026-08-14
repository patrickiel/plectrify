import type {
  AppSettings,
  MidiTrigger,
  NeedlePrecision,
  StrobePrecision,
  ThemeName,
  ToolId,
  TunerDisplayMode,
} from './types';
import { isMidiTrigger } from './midi';
import {
  normalizeActiveSetlistId,
  normalizeActiveSongId,
  normalizeSetlists,
  normalizeSongs,
} from './songs';

/** Selectable strobe precisions, coarsest first. Each is the harmonic the top row
    watches; the row below always watches four times that. */
export const STROBE_PRECISIONS: readonly StrobePrecision[] = [1, 2, 4];

/** Selectable needle-scale magnifications, linear first. Each is how many times
    wider the cents around zero render than on the linear scale. */
export const NEEDLE_PRECISIONS: readonly NeedlePrecision[] = [1, 2, 4];

export const MIN_RACK_ZOOM = 0.5;
export const MAX_RACK_ZOOM = 2;
export const RACK_ZOOM_STEP = 0.05;

/** Chrome scale (toolbar, sidebar, status bar). Same 50–200% range as the rack
    zoom so both readouts move over the same span. */
export const MIN_UI_SCALE = 0.5;
export const MAX_UI_SCALE = 2;
export const UI_SCALE_STEP = 0.05;

/** Module-drawer height range, CSS pixels before the chrome scale. The floor
    keeps one row of patch tiles usable; the ceiling is only the persistence
    cap — at runtime the drawer is further limited to the workspace's actual
    height, so "as tall as it goes" survives a move to a bigger window. */
export const MIN_DRAWER_HEIGHT = 150;
export const MAX_DRAWER_HEIGHT = 1600;

/** Offered Auto Standby delays, in minutes. Discrete rather than a free slider
    because every write rewrites settings.json over the bridge — a dragged
    control would hammer it. */
export const STANDBY_LIGHT_DELAYS: readonly number[] = [1, 2, 5, 10, 20, 30];
/** Deep-standby delays. Longer than the light ones because waking re-creates
    every plugin: an IR loader alone can take seconds, so parking after a short
    break would cost more than it saves. */
export const STANDBY_DEEP_DELAYS: readonly number[] = [15, 30, 45, 60, 120];
/** Offered wake thresholds, in dBFS. -60 is the meter's own floor; the quieter
    settings suit a hot pickup or a noisy room. */
export const STANDBY_THRESHOLDS: readonly number[] = [-70, -60, -50, -40, -30];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  rackZoom: 1,
  uiScale: 1,
  editMode: false,
  drawerHeight: 248,
  drawerCollapsed: false,
  drawerOpenSection: '',
  catalogueHintDismissed: false,
  activeRigId: '',
  lastSceneByRig: {},
  theme: 'dark',
  tunerDisplay: 'needle',
  tunerStrobePrecision: 2,
  tunerNeedlePrecision: 2,
  standbyEnabled: false,
  standbyLightAfterMinutes: 10,
  standbyDeepAfterMinutes: 0,
  standbyWakeThresholdDb: -50,
  looperViewMode: 'simple',
  metronomeViewMode: 'simple',
  songEditMode: false,
  looperSessionAutoCleanup: true,
  looperSessionAutoCleanupLimit: 20,
  updateDismissedVersion: '',
  midiBindings: {},
  activeTool: null,
  songs: [],
  setlists: [],
  activeSetlistId: '',
  activeSongId: '',
};

/** Every panel the rail offers. Must list the whole ToolId union: a member
    missing here is silently rejected by `activeTool()` below, so that panel can
    never be restored as the open one. The Record type makes the compiler catch
    the omission instead of leaving it to be found by hand. */
const TOOL_ID_SET: Record<ToolId, true> = {
  looper: true,
  metronome: true,
  setlist: true,
  plugins: true,
  info: true,
  settings: true,
};

export const TOOL_IDS: readonly ToolId[] = Object.keys(TOOL_ID_SET) as ToolId[];

/** Guard the theme union: an unknown or renamed theme falls back rather than
    leaving the UI unstyled. */
function themeName(value: unknown): ThemeName {
  return value === 'light' || value === 'dark' ? value : DEFAULT_APP_SETTINGS.theme;
}

/** Guard the tuner-readout union, same shape as themeName. Falls back to the
    needle, which works at any window width and needs no motion. */
function tunerDisplayMode(value: unknown): TunerDisplayMode {
  return value === 'needle' || value === 'strobe' ? value : DEFAULT_APP_SETTINGS.tunerDisplay;
}

/** Guard the strobe precision against the offered set, so a hand-edited or
    stale settings file can't ask for a multiplier the display never offers. */
function strobePrecision(value: unknown): StrobePrecision {
  return (
    STROBE_PRECISIONS.find((precision) => precision === value) ??
    DEFAULT_APP_SETTINGS.tunerStrobePrecision
  );
}

/** Guard the needle magnification the same way. */
function needlePrecision(value: unknown): NeedlePrecision {
  return (
    NEEDLE_PRECISIONS.find((precision) => precision === value) ??
    DEFAULT_APP_SETTINGS.tunerNeedlePrecision
  );
}

/** Guard a performance tool's progressive-disclosure choice. */
function toolViewMode(value: unknown, fallback: 'simple' | 'expert'): 'simple' | 'expert' {
  return value === 'simple' || value === 'expert' ? value : fallback;
}

/** Clamp a zoom/scale factor into its range on the 0.05 grid the ± buttons
    step on, falling back when the stored value isn't a finite number. */
function scaleFactor(value: unknown, min: number, max: number, fallback: number): number {
  const factor = Number(value);
  return Number.isFinite(factor)
    ? Math.round(Math.max(min, Math.min(max, factor)) * 20) / 20
    : fallback;
}

/** Guard a standby delay/threshold against the offered set. A hand-edited or
    stale settings file must not be able to ask the engine for a two-second
    timeout — the engine clamps too, but the UI has to render a real choice. */
function offered(value: unknown, choices: readonly number[], fallback: number): number {
  return choices.find((choice) => choice === value) ?? fallback;
}

/** Guard the open-tool choice against the offered set. Carries a one-way
    migration from the pre-rail boolean: a settings file with
    toolsSidebarOpen: true meant "the looper panel is open". */
function activeTool(value: unknown, legacyOpen: unknown): ToolId | null {
  return TOOL_IDS.find((tool) => tool === value) ?? (legacyOpen === true ? 'looper' : null);
}

/** Keep only well-formed string→string entries from a persisted scene map. */
function sceneMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, sceneId]) => typeof sceneId === 'string'),
  ) as Record<string, string>;
}

/** Action keys a MIDI binding may be stored under: index-based rig/scene
    selects plus the fixed verbs. Anything else in a persisted file is stale
    or hand-edited and is dropped. */
const MIDI_ACTION_KEY =
  /^(?:rig:\d+|scene:\d+|rigNext|rigPrev|sceneNext|scenePrev|tunerToggle|outputMute|looperToggle|looperStop|looperClear|looperUndo|looperMaximize|metronomeToggle|metronomeTapTempo|metronomeTempoDown|metronomeTempoUp|metronomeMaximize|songNext|songPrev|songMaximize)$/;

/** Keep only well-formed action→trigger entries from a persisted binding map,
    re-built field by field so stray extra properties don't survive a load. */
function midiBindingsMap(value: unknown): Record<string, MidiTrigger> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([action, trigger]) => MIDI_ACTION_KEY.test(action) && isMidiTrigger(trigger))
      .map(([action, trigger]) => [
        action,
        { type: trigger.type, channel: trigger.channel, number: trigger.number },
      ]),
  );
}

/** Validate persisted preferences independently of rigs and the working session. */
export function normalizeAppSettings(value: unknown): AppSettings {
  const candidate = value as Partial<AppSettings> | null;
  const bool = (flag: unknown, fallback: boolean) => (typeof flag === 'boolean' ? flag : fallback);
  // Order matters: the setlists are validated against the library that survived
  // (so a dropped song can't linger as a reference), and both selections against
  // what those two produced.
  const songs = normalizeSongs(candidate?.songs);
  const setlists = normalizeSetlists(candidate?.setlists, songs);
  return {
    rackZoom: scaleFactor(
      candidate?.rackZoom,
      MIN_RACK_ZOOM,
      MAX_RACK_ZOOM,
      DEFAULT_APP_SETTINGS.rackZoom,
    ),
    uiScale: scaleFactor(
      candidate?.uiScale,
      MIN_UI_SCALE,
      MAX_UI_SCALE,
      DEFAULT_APP_SETTINGS.uiScale,
    ),
    editMode: bool(candidate?.editMode, DEFAULT_APP_SETTINGS.editMode),
    drawerHeight: Number.isFinite(Number(candidate?.drawerHeight))
      ? Math.max(
          MIN_DRAWER_HEIGHT,
          Math.min(MAX_DRAWER_HEIGHT, Math.round(Number(candidate?.drawerHeight))),
        )
      : DEFAULT_APP_SETTINGS.drawerHeight,
    drawerCollapsed: bool(candidate?.drawerCollapsed, DEFAULT_APP_SETTINGS.drawerCollapsed),
    drawerOpenSection:
      typeof candidate?.drawerOpenSection === 'string' ? candidate.drawerOpenSection : '',
    catalogueHintDismissed: bool(
      candidate?.catalogueHintDismissed,
      DEFAULT_APP_SETTINGS.catalogueHintDismissed,
    ),
    activeRigId: typeof candidate?.activeRigId === 'string' ? candidate.activeRigId : '',
    lastSceneByRig: sceneMap(candidate?.lastSceneByRig),
    theme: themeName(candidate?.theme),
    tunerDisplay: tunerDisplayMode(candidate?.tunerDisplay),
    tunerStrobePrecision: strobePrecision(candidate?.tunerStrobePrecision),
    tunerNeedlePrecision: needlePrecision(candidate?.tunerNeedlePrecision),
    standbyEnabled: bool(candidate?.standbyEnabled, DEFAULT_APP_SETTINGS.standbyEnabled),
    standbyLightAfterMinutes: offered(
      candidate?.standbyLightAfterMinutes,
      STANDBY_LIGHT_DELAYS,
      DEFAULT_APP_SETTINGS.standbyLightAfterMinutes,
    ),
    // 0 is a real value here — it means "never go deep" — so it is accepted
    // alongside the offered delays rather than falling back.
    standbyDeepAfterMinutes: offered(
      candidate?.standbyDeepAfterMinutes,
      [0, ...STANDBY_DEEP_DELAYS],
      DEFAULT_APP_SETTINGS.standbyDeepAfterMinutes,
    ),
    standbyWakeThresholdDb: offered(
      candidate?.standbyWakeThresholdDb,
      STANDBY_THRESHOLDS,
      DEFAULT_APP_SETTINGS.standbyWakeThresholdDb,
    ),
    looperViewMode: toolViewMode(candidate?.looperViewMode, DEFAULT_APP_SETTINGS.looperViewMode),
    metronomeViewMode: toolViewMode(
      candidate?.metronomeViewMode,
      DEFAULT_APP_SETTINGS.metronomeViewMode,
    ),
    songEditMode: bool(candidate?.songEditMode, DEFAULT_APP_SETTINGS.songEditMode),
    looperSessionAutoCleanup: bool(
      candidate?.looperSessionAutoCleanup,
      DEFAULT_APP_SETTINGS.looperSessionAutoCleanup,
    ),
    looperSessionAutoCleanupLimit: Number.isFinite(Number(candidate?.looperSessionAutoCleanupLimit))
      ? Math.max(1, Math.min(999, Math.round(Number(candidate?.looperSessionAutoCleanupLimit))))
      : DEFAULT_APP_SETTINGS.looperSessionAutoCleanupLimit,
    // Not validated against a version pattern: an unrecognisable value simply
    // matches no release, which fails safe by showing the notice.
    updateDismissedVersion:
      typeof candidate?.updateDismissedVersion === 'string' ? candidate.updateDismissedVersion : '',
    midiBindings: midiBindingsMap(candidate?.midiBindings),
    activeTool: activeTool(
      candidate?.activeTool,
      (value as Record<string, unknown> | null)?.['toolsSidebarOpen'],
    ),
    songs,
    setlists,
    activeSetlistId: normalizeActiveSetlistId(candidate?.activeSetlistId, setlists),
    activeSongId: normalizeActiveSongId(candidate?.activeSongId, songs),
  };
}
