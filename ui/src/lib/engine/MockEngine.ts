import type {
  EngineBridge,
  ModuleInsertTarget,
  ModuleMoveTarget,
  ModuleStyleUpdate,
  PluginScanState,
  SettableStatus,
  WindowResizeEdge,
} from './EngineBridge';
import type {
  AppInfo,
  AppSettings,
  AudioDeviceChange,
  AudioDevicesState,
  AudioDriverInfo,
  BlacklistedPlugin,
  EngineBusyState,
  LooperSession,
  LooperState,
  MidiEvent,
  MidiTrigger,
  Patch,
  LaneMix,
  MappedParam,
  ParamRef,
  PluginInfo,
  Rig,
  RackModule,
  RoutingState,
  Scene,
  SceneState,
  StatusState,
} from './types';
import { looperSessionName, normalizeLooperSessions, pruneLooperSessions } from './looperSessions';
import { DEFAULT_STATUS_STATE } from './types';
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from './appSettings';
import { knobMeterPatch } from './contentMidi';
import { asModuleColor, asModuleIcon, asModuleTexture, asStyleVariant } from './moduleAppearance';
import { firstFreePos, moveKnobToPos, normalizePositions } from './knobLayout';
import { laneName, makeLane, nextLaneName, normalizeRoutingState } from './routing';
import { moveModuleInRack, resolveInsert, swapModulesInRack } from './rackMove';
import {
  byName,
  mergePatches,
  patchTitleOverride,
  storedFromModule,
  toPatch,
  type StoredPatch,
} from './patches';
import { resolveInstallIds } from './catalogue';
import { decideStarterAutoInstall, STARTER_BUNDLE_ID } from './starterBundle';
import type {
  InstallFinished,
  CataloguePackage,
  CatalogueBundle,
  InstallProgress,
  CatalogueState,
} from './catalogue';
import type {
  Tone3000InstallEvent,
  Tone3000Model,
  Tone3000Provenance,
  Tone3000State,
  Tone3000Tone,
} from './tone3000';
import { findTone3000Patch, NAM_PLUGIN_NAME, patchesMissingCaptures } from './tone3000';
import { MOCK_TONES, mockModelsFor } from './tone3000Fixtures';
import { nextRigName } from './rigNames';
import { captureScene, isSceneArray, reconcileScenes, remapSceneIds } from './scenes';
import { uid } from './ids';

/** One localStorage key stands in for JuceEngine's patches directory: patch
    id -> the whole stored patch, mapping and tone together, exactly as one
    file holds them there. A mock plugin has no serialised state, so the tone
    is the module's parameter values â€” opaque to everything downstream, like
    the real base64 blob, and enough to make a patch load audibly change the
    rack in browser development. */
const PATCHES_KEY = 'plectrify.patches';

/** Stands in for a patch pack installed under the shared package root, which
    the browser has no equivalent of. Fixed rather than stored: a pack is not
    the user's to change, so `pnpm dev` exercises the read-only path â€” the badge
    and the disabled rename/delete â€” without a real install. The id is the
    package id, exactly as the installed folder is named for it â€” which is
    also what files the patch under its package's drawer heading. */
const SHIPPED_PATCHES: Record<string, StoredPatch> = {
  'amalgam-jtm45': {
    name: 'JTM45',
    pluginName: NAM_PLUGIN_NAME,
    knobs: [
      { paramIndex: 1, label: 'Input', pos: 0 },
      { paramIndex: 3, label: 'Bass', pos: 1 },
      { paramIndex: 4, label: 'Middle', pos: 2 },
      { paramIndex: 5, label: 'Treble', pos: 3 },
      { paramIndex: 6, label: 'Output', pos: 4 },
    ],
  },
};

const SHIPPED_LIST: Patch[] = patchList(SHIPPED_PATCHES, true);
const RIGS_KEY = 'plectrify.rigs';
const WORKING_KEY = 'plectrify.workingRack';
/** Written by older builds that kept an undo timeline; read once for
    migration, then removed. */
const LEGACY_HISTORY_KEY = 'plectrify.workingHistory';
const SETTINGS_KEY = 'plectrify.settings';
const LOOPER_SESSIONS_KEY = 'plectrify.looperSessions';

interface WorkingSnapshot {
  modules: RackModule[];
  routing: RoutingState;
  /** Scenes travel with the working rack (absent in old snapshots). The
      active scene is workspace state, remembered per rig in app settings. */
  scenes?: Scene[];
}

/** A stored rig: the public {id, name} plus the full chain snapshot. In the
    mock, cloning the rack modules stands in for the native engine's per-plugin
    binary state â€” it captures every knob, value and bypass exactly. */
interface StoredRig extends Rig {
  modules: RackModule[];
  /** Parallel-routing topology captured with the chain (absent for old rigs). */
  routing?: RoutingState;
  /** Scenes belonging to this rig (absent for old rigs). */
  scenes?: Scene[];
}

/** A plausible spread of parameters a hosted plugin might expose â€” used so the
    mapping picker has something to choose from in the browser demo. */
const MOCK_PARAM_NAMES = [
  'Input Gain',
  'Bass',
  'Mid',
  'Treble',
  'Presence',
  'Master',
  'Drive',
  'Tone',
  'Level',
  'Mix',
  'Decay',
  'Size',
  'Bypass',
  'Mute',
  'Output Meter',
  'Tuner',
];

/** Names the mock treats as two-state toggles (rendered as switches). */
const MOCK_BOOLEAN_PARAMS = new Set(['Bypass', 'Mute']);
const isBooleanParam = (name: string) => MOCK_BOOLEAN_PARAMS.has(name);

/** Names the mock treats as read-only readouts (default to a meter display). */
const MOCK_READONLY_PARAMS = new Set(['Output Meter', 'Tuner']);
const isReadOnlyParam = (name: string) => MOCK_READONLY_PARAMS.has(name);
/** Formatted like a real plugin's getText would be (dB for gain-ish params,
    a musical range for tone controls), so the mock readout matches the host. */
const valueText = (name: string, v: number) => {
  if (isBooleanParam(name)) return v >= 0.5 ? 'On' : 'Off';
  if (/gain|master|level|drive|output/i.test(name)) return `${(v * 48 - 24).toFixed(1)} dB`;
  if (/decay/i.test(name)) return `${(0.1 + v * 9.9).toFixed(2)} s`;
  return `${(v * 10).toFixed(1)}`;
};

const NO_ROUTING: RoutingState = { groups: [] };

/** A plausible machine for the setup wizard to be built against: an ASIO
    interface with four jacks, and the OS's own shared driver beside it â€” which
    is the split the wizard's advice exists for. Both families are here so the
    device step has something to switch between, and so the "you could be on
    ASIO" note has a case where it is right and one where it is not. */
const MOCK_DRIVERS: AudioDriverInfo[] = [
  {
    name: 'ASIO',
    separateInputsAndOutputs: false,
    outputDevices: ['Focusrite USB ASIO', 'ASIO4ALL v2'],
    inputDevices: ['Focusrite USB ASIO', 'ASIO4ALL v2'],
  },
  {
    name: 'Windows Audio',
    separateInputsAndOutputs: true,
    outputDevices: ['Speakers (Realtek)', 'Headphones (Focusrite)'],
    inputDevices: ['Microphone (Realtek)', 'Line In 1/2 (Focusrite)'],
  },
];

/** Which jack the mock's guitar is in. Not the first, deliberately: a wizard
    that only ever detects channel 0 is a wizard nobody has tested. */
const MOCK_GUITAR_CHANNEL = 1;

function mockInputChannels(deviceName: string): string[] {
  // A one-in device is a real shape too, and the step has to read sensibly
  // when there is nothing to choose between.
  if (deviceName.startsWith('Microphone')) return ['Mic'];
  if (deviceName.startsWith('ASIO4ALL')) return ['Input 1', 'Input 2'];
  return ['Input 1', 'Input 2', 'Input 3', 'Input 4'];
}

function mockAudioDevices(): AudioDevicesState {
  const driver = MOCK_DRIVERS[0];
  return {
    drivers: MOCK_DRIVERS,
    driver: driver.name,
    outputDevice: driver.outputDevices[0],
    inputDevice: driver.inputDevices[0],
    open: true,
    sampleRate: 48000,
    sampleRates: [44100, 48000, 88200, 96000],
    bufferSize: 128,
    bufferSizes: [32, 64, 128, 256, 512, 1024],
    recommendedBufferSize: 256,
    inputChannels: mockInputChannels(driver.outputDevices[0]),
    inputChannel: 0,
    deviceLatencySamples: 256,
  };
}

/** Pitches the demo tuner walks, as MIDI notes: 5-string bass low B, low E,
    open A, concert A, and the top of the detector's range. The extremes are the
    point â€” a low B is where the strobe's harmonic lanes earn their keep, and E6
    is where its drift rate starts to outrun 60 fps. Same notes as
    Tests/audio/TunerDetectorTests.cpp. */
const TUNER_DEMO_NOTES = [23, 40, 45, 69, 88];
const TUNER_DEMO_SECONDS_PER_NOTE = 10;

/** A scripted detune, held long enough at each step to actually watch. Walks
    every regime the strobe has to handle: too fast to resolve, fast, readable,
    barely creeping, dead still, then the same again flat. A sine sweep would be
    useless here â€” it reverses the drift several times a second, so the one state
    that matters most, the freeze, would never appear. */
const TUNER_DEMO_STAGES: readonly { cents: number; seconds: number; silent?: boolean }[] = [
  { cents: 22, seconds: 2.5 },
  { cents: 8, seconds: 2.5 },
  { cents: 2.5, seconds: 3 },
  { cents: 0.6, seconds: 3 },
  { cents: 0, seconds: 4 },
  { cents: -0.6, seconds: 3 },
  { cents: -3, seconds: 2.5 },
  { cents: -14, seconds: 2.5 },
  // Keeps the UI's hold â†’ fade â†’ drop path exercised on every lap.
  { cents: 0, seconds: 1, silent: true },
];
const TUNER_DEMO_CYCLE_SECONDS = TUNER_DEMO_STAGES.reduce(
  (total, stage) => total + stage.seconds,
  0,
);
/** Fraction of a stage spent gliding in from the previous one, so transitions
    look like a peg being turned rather than a jump cut. */
const TUNER_DEMO_RAMP = 0.35;

/** `?tuner=` pins one regime while iterating on the display: `hold` freezes it
    in tune, `noise` freezes it but quadruples the simulated detector noise to
    stress the wobble, and a bare number holds that many cents. Anything else
    runs the full script. */
function tunerDemoOverride(): { cents: number; noiseScale: number } | undefined {
  const mode = new URLSearchParams(location.search).get('tuner');
  if (mode === null || mode === 'sweep') return undefined;
  if (mode === 'hold') return { cents: 0, noiseScale: 1 };
  if (mode === 'noise') return { cents: 0, noiseScale: 4 };
  const cents = Number(mode);
  return Number.isFinite(cents) ? { cents, noiseScale: 1 } : undefined;
}

/** `?note=` pins the demo to one MIDI note instead of cycling. Pitch decides
    which strobe rows are usable at all, so holding it still is what makes a
    screenshot or a side-by-side comparison mean anything. */
function tunerDemoNote(): number | undefined {
  const midiNote = Number(new URLSearchParams(location.search).get('note'));
  return Number.isInteger(midiNote) && midiNote > 0 ? midiNote : undefined;
}

/** Seeded 32-bit LCG, same shape as the native tuner tests' noise floor, so the
    demo replays identically across reloads and two screenshots are comparable.
    The top bits only â€” an LCG's low bits cycle far too short to look random. */
let tunerNoiseState = 22222;
function tunerNoise(): number {
  tunerNoiseState = (Math.imul(tunerNoiseState, 1103515245) + 12345) >>> 0;
  return (tunerNoiseState >>> 8) / 0x1000000 - 0.5;
}

/** Where the scripted detune is at `elapsed` seconds, glide included. */
function tunerDemoStage(elapsed: number): { cents: number; detected: boolean } {
  let remaining = elapsed % TUNER_DEMO_CYCLE_SECONDS;
  for (const [index, stage] of TUNER_DEMO_STAGES.entries()) {
    if (remaining >= stage.seconds) {
      remaining -= stage.seconds;
      continue;
    }
    if (stage.silent) return { cents: 0, detected: false };
    const previous =
      TUNER_DEMO_STAGES[(index - 1 + TUNER_DEMO_STAGES.length) % TUNER_DEMO_STAGES.length];
    // Coming back from the dropout there is nothing to glide from â€” the note has
    // just been plucked again, so it arrives already at pitch.
    const from = previous.silent ? stage.cents : previous.cents;
    const glide = Math.min(1, remaining / (stage.seconds * TUNER_DEMO_RAMP));
    return { cents: from + (stage.cents - from) * glide, detected: true };
  }
  return { cents: 0, detected: true };
}

function loadStoredPatches(): Record<string, StoredPatch> {
  try {
    const raw = localStorage.getItem(PATCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
      ? (parsed as Record<string, StoredPatch>)
      : {}; // an array is the index older builds wrote; nothing to migrate here
  } catch {
    return {};
  }
}

/** The list the UI sees, built from the stored patches the same way the real
    engine builds it from the directory. */
function patchList(stored: Record<string, StoredPatch>, readOnly = false): Patch[] {
  return Object.entries(stored)
    .map(([id, doc]) => toPatch(id, doc, readOnly))
    .sort(byName);
}

/** The mock's plugin state: every parameter value the module currently holds,
    mapped or not â€” the point being that a patch restores more than its own
    knobs. */
function mockStateOf(module: RackModule): string {
  return JSON.stringify(module.params.map(({ paramIndex, value }) => ({ paramIndex, value })));
}

/** Overlay a stored mock state onto freshly-built knobs. Unknown parameters in
    the blob are ignored: the knob array is the patch's, not the blob's. */
function withMockState(knobs: MappedParam[], state: string | undefined): MappedParam[] {
  if (!state) return knobs;
  let stored: Array<{ paramIndex: number; value: number }>;
  try {
    stored = JSON.parse(state) as Array<{ paramIndex: number; value: number }>;
  } catch {
    return knobs;
  }
  const byIndex = new Map(stored.map((p) => [p.paramIndex, p.value]));
  return knobs.map((k) => {
    const value = byIndex.get(k.paramIndex);
    return value === undefined ? k : { ...k, value, text: valueText(k.label, value) };
  });
}

/** A patch's mapping wearing the module's *current* readings, param by param.
    What a preview shows: the plugin itself has not been touched, so a knob the
    patch points at a parameter the module already had keeps that parameter's
    value. The real engine gets this for free â€” its values come from polling the
    live plugin â€” so this is only the mock catching up to it. */
function withLiveValues(knobs: MappedParam[], live: MappedParam[]): MappedParam[] {
  const byIndex = new Map(live.map((p) => [p.paramIndex, p]));
  return knobs.map((k) => {
    const current = byIndex.get(k.paramIndex);
    return current === undefined ? k : { ...k, value: current.value, text: current.text };
  });
}

function loadStoredRigs(): StoredRig[] {
  try {
    const raw = localStorage.getItem(RIGS_KEY);
    return raw ? (JSON.parse(raw) as StoredRig[]) : [];
  } catch {
    return [];
  }
}

function isWorkingSnapshot(value: unknown): value is WorkingSnapshot {
  const snapshot = value as Partial<WorkingSnapshot> | null;
  return Array.isArray(snapshot?.modules) && Array.isArray(snapshot?.routing?.groups);
}

/** The persisted working rack, if any. Reads the current key first, then
    migrates the cursor entry of an old undo-timeline document and removes it. */
function loadWorkingSnapshot(): WorkingSnapshot | undefined {
  try {
    const raw = localStorage.getItem(WORKING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (isWorkingSnapshot(parsed)) return parsed;

    const legacyRaw = localStorage.getItem(LEGACY_HISTORY_KEY);
    if (!legacyRaw) return undefined;
    localStorage.removeItem(LEGACY_HISTORY_KEY);
    const doc = JSON.parse(legacyRaw) as { entries?: unknown[]; cursor?: number } | null;
    const entry = doc?.entries?.[doc?.cursor ?? -1];
    return isWorkingSnapshot(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function loadStoredLooperSessions(): LooperSession[] {
  try {
    const raw = localStorage.getItem(LOOPER_SESSIONS_KEY);
    return normalizeLooperSessions(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return [];
  }
}

function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? normalizeAppSettings(JSON.parse(raw) as unknown) : { ...DEFAULT_APP_SETTINGS };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/** Build live knobs from a saved patch (used both when loading onto an
    existing module and when adding a module with a mapping pre-applied). */
function knobsFromPatch(patch: StoredPatch): MappedParam[] {
  return normalizePositions(
    patch.knobs.map((k) => ({
      knobId: uid('knob'),
      paramIndex: k.paramIndex,
      label: k.label,
      value: isBooleanParam(k.label) ? 0 : 0.5,
      text: valueText(k.label, isBooleanParam(k.label) ? 0 : 0.5),
      isBoolean: isBooleanParam(k.label),
      isMeter: k.isMeter,
      meterBipolar: k.meterBipolar,
      pos: k.pos,
    })),
  );
}

/** Deep-clone a rack snapshot so a loaded rig is independent of the live rack
    (and vice-versa). structuredClone is fine for our plain-data modules. */
const cloneModules = (mods: RackModule[]): RackModule[] => structuredClone(mods);

// A tiny pool of stand-in plugin "types". Names repeat across instances (like
// real VSTs), so a mapping saved on one can be loaded onto another. In the mock
// the plugin `id` is just its name.
/** Mirrors packaging/catalogue.json, with the disk-state fields varied so
    the panel's every row state is reachable in the browser: one installed and
    current, one installed but behind, the rest not installed. The patch and
    the plugin it depends on are both here so the dependency line, and an
    install that fetches two packages from one click, are reachable too.

    Effects is deliberately mixed: two packages filed under it directly and one
    in an "Effects > Reverb" subsection, so a card with both its own rows and a
    nested heading â€” the shape a flat category list could not produce â€” is
    visible without a native build. */
const MOCK_CATALOGUE: CataloguePackage[] = [
  {
    id: 'neural-amp-modeler',
    kind: 'plugin',
    category: ['Amps'],
    tags: ['Amps', 'Captures'],
    name: 'Neural Amp Modeler',
    purpose: 'Amp sim - plays .nam capture files',
    version: '0.7.15',
    licenseId: 'MIT',
    licenseUrl: 'https://example.invalid/LICENSE',
    projectUrl: 'https://github.com/sdatkinson/NeuralAmpModelerPlugin',
    downloadBytes: 2263175,
    selfHosted: true,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: '',
    dependsOn: '',
  },
  {
    // The dependency case: a patch is a knob mapping plus one plugin's own
    // saved state, so it names that plugin and installing it installs both.
    id: 'amalgam-jtm45',
    kind: 'content',
    category: ['Amps'],
    tags: ['Amps'],
    name: 'JTM45',
    purpose: '1966 JTM45 into a Bluesbreaker cab - knobs, tone and capture',
    version: '3',
    licenseId: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    projectUrl: 'https://github.com/patrickiel/plectrify',
    downloadBytes: 133225,
    selfHosted: true,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: 'C:\\ProgramData\\Plectrify\\patches',
    dependsOn: 'neural-amp-modeler',
  },
  {
    id: 'zam-plugins',
    kind: 'plugin',
    category: ['Effects'],
    tags: ['Multi-effect', 'Dynamics', 'EQ', 'Delay'],
    name: 'ZamPlugins',
    purpose: 'Gate, compressor, EQ, delay and more',
    version: '4.5',
    licenseId: 'GPL-2.0-or-later',
    licenseUrl: 'https://raw.githubusercontent.com/zamaudio/zam-plugins/4.5/COPYING',
    projectUrl: 'https://github.com/zamaudio/zam-plugins',
    downloadBytes: 128302481,
    selfHosted: false,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: '',
    dependsOn: '',
  },
  {
    id: 'reev-r',
    kind: 'plugin',
    category: ['Cabs & IRs'],
    tags: ['Cabs & IRs', 'Reverb'],
    name: 'REEV-R',
    purpose: 'Cabinet IR loader (convolution)',
    version: '1.4.0',
    licenseId: 'GPL-3.0-only',
    licenseUrl: 'https://raw.githubusercontent.com/tiagolr/reevr/master/LICENSE',
    projectUrl: 'https://github.com/tiagolr/reevr',
    downloadBytes: 7730204,
    selfHosted: false,
    installed: true,
    installedVersion: '1.4.0',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: '',
    dependsOn: '',
  },
  {
    // Content in the same list as the plugins, which is the whole point of the
    // unified model: it sits under the same heading as the loader that plays it.
    id: 'cab-irs',
    kind: 'content',
    category: ['Cabs & IRs'],
    tags: ['Cabs & IRs'],
    name: 'Cabinet IRs',
    purpose: '20 guitar cabinet impulse responses for REEV-R',
    version: '1',
    licenseId: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    projectUrl: 'https://www.jester-dyne-productions.com/',
    downloadBytes: 2521555,
    selfHosted: true,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: true,
    unlisted: false,
    dir: 'C:\\ProgramData\\Plectrify\\irs',
    dependsOn: '',
  },
  {
    id: 'dragonfly-reverb',
    kind: 'plugin',
    category: ['Effects', 'Reverb'],
    tags: ['Reverb'],
    name: 'Dragonfly Reverb',
    purpose: 'Hall, room, plate and early-reflection reverbs',
    version: '3.2.10',
    licenseId: 'GPL-3.0-only',
    licenseUrl: 'https://raw.githubusercontent.com/michaelwillis/dragonfly-reverb/master/LICENSE',
    projectUrl: 'https://github.com/michaelwillis/dragonfly-reverb',
    downloadBytes: 22447365,
    selfHosted: false,
    installed: true,
    installedVersion: '3.2.9',
    updateAvailable: true,
    available: true,
    unlisted: false,
    dir: '',
    dependsOn: '',
  },
  {
    // A package with no payload for the platform this build runs on (the
    // engine decides; on real builds this happens when a catalogue entry has
    // no asset for the current OS). Here so the greyed row with its disabled
    // install is reachable in the browser.
    id: 'stompbox',
    kind: 'plugin',
    category: ['Effects'],
    // Untagged on purpose: an entry that answers to no chip has to be visible
    // in browser development too, since it is what an authored-without-tags
    // catalogue row looks like.
    tags: [],
    name: 'Stompbox',
    purpose: 'Multi-effect pedalboard',
    version: '1.2.0',
    licenseId: 'MIT',
    licenseUrl: 'https://example.invalid/LICENSE',
    projectUrl: 'https://github.com/mikeoliphant/StompboxUi',
    downloadBytes: 9000000,
    selfHosted: false,
    installed: false,
    installedVersion: '',
    updateAvailable: false,
    available: false,
    unlisted: false,
    dir: '',
    dependsOn: '',
  },
];

/** The one bundle, mirroring packaging/catalogue.json. Deliberately shown
    with a plugin already installed and another needing an update, so the
    partially-installed bundle state is reachable in the browser. */
const MOCK_BUNDLE: CatalogueBundle = {
  id: 'starter',
  name: 'Starter bundle',
  description: 'The usual pedals in one go: drive, chorus, delay, and reverb.',
  version: '1',
  packageIds: [
    'neural-amp-modeler',
    'amalgam-jtm45',
    'reev-r',
    'cab-irs',
    'zam-plugins',
    'dragonfly-reverb',
  ],
  missingPackageIds: ['neural-amp-modeler', 'amalgam-jtm45', 'cab-irs', 'zam-plugins'],
  outdatedPackageIds: ['dragonfly-reverb'],
  installedVersion: '',
  installed: false,
  updateAvailable: false,
};

/** Always fails to install in the mock, so the failure copy and the per-row
    Retry are exercised on every browser run rather than only in the wild. */
const MOCK_CATALOGUE_FAILING_ID = 'zam-plugins';

const MOCK_PLUGINS: PluginInfo[] = [
  // `packageId` on the first two joins them to MOCK_CATALOGUE, so a patch
  // saved on either files under that package's drawer heading in `pnpm dev`;
  // the last two have none, exercising the "Uncategorised" fallback.
  {
    id: 'Mock Amp',
    name: 'Mock Amp',
    manufacturer: 'Plectrify Labs',
    packageId: 'neural-amp-modeler',
  },
  { id: 'Mock Drive', name: 'Mock Drive', manufacturer: 'Plectrify Labs' },
  {
    id: 'Mock Reverb',
    name: 'Mock Reverb',
    manufacturer: 'Mockingbird Audio',
    packageId: 'dragonfly-reverb',
  },
  // Left blank on purpose: real scans turn up plugins with no vendor string,
  // and the drawer has to group those somewhere.
  { id: 'Mock Utility', name: 'Mock Utility', manufacturer: '' },
];

// One skipped file so the drawer's blacklist notice and its dialog can be
// exercised in the browser; retrying it clears the list, as a real retry that
// loads cleanly does.
const MOCK_BLACKLIST: BlacklistedPlugin[] = [
  { path: 'C:\\Program Files\\Common Files\\VST3\\Mock Crasher.vst3', name: 'Mock Crasher' },
];

// Version strings the native engine reads off each instance. Distinct per
// plugin so the diagnostics' chain line is exercised the way a real rig shows
// it, rather than repeating one number.
const MOCK_PLUGIN_VERSIONS: Record<string, string> = {
  'Mock Amp': '2.1.0',
  'Mock Drive': '1.0.4',
  'Mock Reverb': '3.2',
  'Mock Utility': '0.9-beta',
};

/** `?host=plugin` renders the mock as the VST3 build: the DAW-owned surfaces
    (setup wizard, audio settings, window chrome, Auto Standby) hide exactly as
    they do inside a real host, so the gated layout is exercisable in the
    browser. Anything else — including absence — is the standalone. */
function mockHostMode(): 'standalone' | 'plugin' {
  return new URLSearchParams(location.search).get('host') === 'plugin' ? 'plugin' : 'standalone';
}

// No exe to ask, and nothing here may pass for a release build: the About
// dialog reports this verbatim, so standalone UI work is never mistaken for the
// shipped app in a bug report. Every group is still populated â€” the diagnostics
// layout has to be built against a full report, not against a page of dashes.
const MOCK_APP_INFO: AppInfo = {
  version: 'dev',
  build: 'Mock',
  os: navigator.platform || 'browser',
  // Derived from the browser rather than hardcoded, so mock sessions on a Mac
  // exercise the same wording branches (Finder, WebKit, no ASIO line) the
  // native mac build takes.
  platform: /mac/i.test(navigator.platform) ? 'macos' : 'windows',
  host: mockHostMode(),
  capabilities:
    mockHostMode() === 'plugin'
      ? {
          audioDevices: false,
          midiDevices: false,
          windowChrome: false,
          autoStandby: false,
          looper: false,
          metronome: false,
          feedbackGuard: false,
        }
      : {
          audioDevices: true,
          midiDevices: true,
          windowChrome: true,
          autoStandby: true,
          looper: true,
          metronome: true,
          feedbackGuard: true,
        },
  juceVersion: '—',
  buildInfo: {
    commit: '',
    dirty: false,
    builtAt: '',
    compiler: 'none (mock)',
    asio: false,
    vst3: false,
  },
  system: {
    os64Bit: true,
    cpuModel: 'Mock CPU',
    cpuVendor: 'Plectrify Labs',
    cpuSpeedMhz: 3600,
    cpuCores: navigator.hardwareConcurrency || 8,
    cpuPhysicalCores: Math.max(1, Math.floor((navigator.hardwareConcurrency || 8) / 2)),
    ramTotalMb: 16384,
    language: 'en',
    region: 'US',
    displayWidth: window.screen?.width,
    displayHeight: window.screen?.height,
    displayScale: window.devicePixelRatio,
    displayCount: 1,
  },
  audio: {
    driverType: 'Mock',
    deviceName: 'Mock Audio Device',
    bitDepth: 24,
    inputChannels: 1,
    outputChannels: 2,
    inputLatencySamples: 128,
    outputLatencySamples: 192,
  },
  plugins: { known: MOCK_PLUGINS.length, blacklisted: MOCK_BLACKLIST.length },
};

function makeModule(pluginId: string): RackModule {
  const availableParams: ParamRef[] = MOCK_PARAM_NAMES.map((name, index) => ({
    index,
    name,
    defaultValue: isBooleanParam(name) ? 0 : 0.5,
    isBoolean: isBooleanParam(name) || undefined,
    isReadOnly: isReadOnlyParam(name) || undefined,
  }));

  const plugin = MOCK_PLUGINS.find((p) => p.id === pluginId) ?? MOCK_PLUGINS[0];

  // Generic box: no knobs by default. The user maps them.
  return {
    id: uid('mod'),
    name: plugin.name,
    pluginVersion: MOCK_PLUGIN_VERSIONS[plugin.name],
    pluginManufacturer: plugin.manufacturer,
    bypassed: false,
    params: [],
    availableParams,
  };
}

/** Mirror the native host's missing-plugin handling on restore: a stored
    module whose plugin is no longer in the catalog stays in the chain, marked
    missing with an empty param palette (audibly it would pass through). One
    whose plugin is back ("reinstalled") loses the mark and gets its palette
    rebuilt â€” the snapshot itself is otherwise untouched, so nothing is lost
    while the plugin is away. */
function withMissingState(module: RackModule): RackModule {
  if (MOCK_PLUGINS.some((p) => p.name === module.name)) {
    return module.missing
      ? { ...module, missing: undefined, availableParams: makeModule(module.name).availableParams }
      : module;
  }
  return { ...module, missing: true, availableParams: [] };
}

/**
 * In-memory stand-in for the audio engine. Fully interactive so the UI can be
 * built and demoed in the browser with no JUCE/VSTs present.
 */
export class MockEngine implements EngineBridge {
  private rack: RackModule[] = [];
  private listeners = new Set<(rack: RackModule[]) => void>();
  private routing: RoutingState = { ...NO_ROUTING };
  private routingListeners = new Set<(r: RoutingState) => void>();
  /** Patch id -> the whole patch. JuceEngine keeps one file per patch; here
      one object is the whole directory. */
  private storedPatches: Record<string, StoredPatch> = loadStoredPatches();
  private patchListeners = new Set<(a: Patch[]) => void>();
  /** The audition run in flight: the module whose patch menu is being walked,
      and the module as it was before the first patch was tried. Modules are
      replaced rather than mutated here, so holding the old object is the whole
      snapshot. Never persisted â€” an audition is a pointer resting on a row. */
  private patchPreview: { moduleId: string; module: RackModule } | null = null;
  private rigs: StoredRig[] = loadStoredRigs();
  private rigListeners = new Set<(r: Rig[]) => void>();
  private scenes: Scene[] = [];
  private activeSceneId: string | null = null;
  private sceneListeners = new Set<(s: SceneState) => void>();
  private pluginListeners = new Set<(p: PluginInfo[]) => void>();
  private pluginScan: PluginScanState = { status: 'idle', pluginCount: MOCK_PLUGINS.length };
  private pluginScanListeners = new Set<(state: PluginScanState) => void>();
  private blacklistedPlugins: BlacklistedPlugin[] = [...MOCK_BLACKLIST];
  private blacklistListeners = new Set<(entries: BlacklistedPlugin[]) => void>();

  private catalogue: CatalogueState = {
    items: MOCK_CATALOGUE.map((item) => ({ ...item })),
    bundles: [MOCK_BUNDLE],
    // Two top-level categories, a subsection under one of them, and one
    // uncategorised link â€” so the panel's nesting and its trailing fallback
    // heading are both visible in browser development. The real catalogue
    // publishes three flat link categories, which would exercise neither.
    links: [
      {
        category: ['Amp captures and IRs'],
        tags: ['Amps', 'Captures'],
        label: 'Get amp captures',
        url: 'https://www.tone3000.com/',
        note: 'Free .nam captures for Neural Amp Modeler',
      },
      {
        category: ['Amp captures and IRs', 'Cabinet IRs'],
        tags: ['Cabs & IRs'],
        label: 'Get cabinet IRs',
        url: 'https://freesound.org/people/jesterdyne/packs/6385/',
        note: 'Free CC0 cabinet impulse responses for REEV-R',
      },
      {
        category: ['More plugins'],
        tags: ['Multi-effect'],
        label: 'Browse free VST3 plugins',
        url: 'https://kvraudio.com/',
        note: 'Plugins Plectrify does not install for you',
      },
      {
        category: [],
        tags: [],
        label: 'A link with no category',
        url: 'https://example.com/uncategorised',
        note: 'Falls into the trailing group',
      },
    ],
    notices: {
      summary:
        "These are third-party plugins, each under its own open-source licence. Plectrify's installer contains none of them, and nothing is downloaded until you ask for it.",
      fetched:
        "Downloads come straight from each project's own release page over HTTPS and are checked against a pinned checksum before anything is written.",
      hosted: '',
      models: 'No amp capture models are included.',
      uninstall:
        'Plugins install into your own user profile and are left in place if you uninstall Plectrify.',
    },
    busy: false,
    dir: 'C:\\ProgramData\\Plectrify\\plugins',
    source: 'remote',
    error: '',
  };
  private installCancelled = false;
  private runBundleId = '';
  private runRescanAll = false;
  // The first-run starter install, exactly as the real engine does it. The
  // fixture above has packages installed, so it settles to "nothing owed"
  // unless a developer clears localStorage *and* the fixture's installed flags
  // â€” which is how the empty rack's installing state is exercised in the
  // browser.
  private starterChecked = false;
  private starterInstalling = false;
  private starterInstallListeners = new Set<(running: boolean) => void>();
  private catalogueListeners = new Set<(state: CatalogueState) => void>();
  private installProgressListeners = new Set<(event: InstallProgress) => void>();
  private installFinishedListeners = new Set<(result: InstallFinished) => void>();
  private status: StatusState = {
    ...DEFAULT_STATUS_STATE,
    cpuLoad: 0.18,
    processRamMb: 430,
    systemRamTotalMb: 16384,
    sampleRate: 48000,
    bufferSize: 128,
    audioXRuns: 0,
    chainLatencySamples: 64,
    totalLatencySamples: 384,
  };
  private startedAtMs = performance.now();
  private statusListeners = new Set<(status: StatusState) => void>();
  private appSettings = loadAppSettings();
  private appSettingsListeners = new Set<(settings: AppSettings) => void>();
  // Auto Standby, simulated so the UI can be built and demoed standalone. The
  // mock's synthetic input never actually falls silent, so the countdown runs
  // off explicit interaction instead â€” which is what makes the feature
  // observable here without waiting for a real guitar to stop ringing.
  private standbyLastActivityMs = performance.now();
  private standbyWakeAtMs = 0;
  private midiEventListeners = new Set<(events: MidiEvent[]) => void>();
  private audioDevices: AudioDevicesState = mockAudioDevices();
  private audioDeviceListeners = new Set<(state: AudioDevicesState) => void>();
  private inputLevelListeners = new Set<(peaks: number[]) => void>();
  private inputLevelTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // No hardware in the browser: MIDI is driven from the console instead
    // (see injectMidi), so learn mode and dispatch stay demoable standalone.
    (window as { plectrifyInjectMidi?: (event: MidiEvent) => void }).plectrifyInjectMidi = (
      event,
    ) => this.injectMidi([event]);

    // Same reasoning for the feedback guard: nothing here analyses audio, so
    // `plectrifyTripFeedback()` is the only way to see the tripped pill in the
    // browser. Clearing it is the ordinary path â€” a click on the pill.
    (window as { plectrifyTripFeedback?: () => void }).plectrifyTripFeedback = () => {
      this.status = { ...this.status, feedbackMuted: true };
      this.emitStatus();
    };

    const current = loadWorkingSnapshot();
    if (current) {
      this.rack = cloneModules(current.modules).map(withMissingState);
      this.routing = structuredClone(current.routing ?? NO_ROUTING);
      this.scenes = isSceneArray(current.scenes) ? structuredClone(current.scenes) : [];
      this.activeSceneId = this.rememberedScene();
      // Re-persist immediately: a restore that migrated the legacy key has
      // already removed it, and must not depend on a later edit to survive
      // the next reload.
      this.persistWorking();
    }

    // 66 ms to match the native side's 15 Hz status timer, so anything built
    // against the mock sees the same update cadence â€” and the same staircase â€”
    // that it will get from the engine.
    const tunerOverride = tunerDemoOverride();
    const pinnedNote = tunerDemoNote();
    window.setInterval(() => {
      const t = performance.now() / 1000;
      const midiNote =
        pinnedNote ??
        TUNER_DEMO_NOTES[Math.floor(t / TUNER_DEMO_SECONDS_PER_NOTE) % TUNER_DEMO_NOTES.length];
      const reference = 440 * Math.pow(2, (midiNote - 69) / 12);
      const stage = tunerOverride
        ? { cents: tunerOverride.cents, detected: true }
        : tunerDemoStage(t);
      // The detector's own ~1 cent scatter. Without it the mock is far steadier
      // than real hardware and hides the strobe's main design risk entirely:
      // noise on the reading becomes a wobble in the drift rate.
      const cents = stage.cents + tunerNoise() * 0.8 * (tunerOverride?.noiseScale ?? 1);
      const analysing = this.status.tunerEnabled || this.status.midiTunerActive;
      const detected = analysing && stage.detected;
      const standby = this.tickStandby();
      const asleep = standby.standbyStage !== 'active';
      this.status = {
        ...this.status,
        ...standby,
        ...this.tickLooper(performance.now()),
        ...this.tickMetronome(performance.now()),
        // A parked rig is silent: the meters must show that, or the mock would
        // contradict the standby badge it is drawing.
        inputPeak: asleep ? 0 : 0.08 + Math.abs(Math.sin(t * 2.1)) * 0.52,
        outputPeak:
          asleep || this.status.midiTunerActive ? 0 : 0.05 + Math.abs(Math.sin(t * 1.7)) * 0.72,
        tunerReading: detected
          ? // Built the way TunerDetector publishes it: the reference for the
            // stable note, scaled by the smoothed cents.
            {
              detected: true,
              frequencyHz: reference * Math.pow(2, cents / 1200),
              midiNote,
              cents,
              confidence: 0.94,
            }
          : { detected: false },
        // The whole point of the feature: a suspended chain costs no CPU, and a
        // parked one gives its RAM back too.
        cpuLoad: asleep ? 0.01 : 0.18 + 0.07 * Math.sin(t * 0.6) + 0.04 * Math.sin(t * 3.1),
        processRamMb:
          standby.standbyStage === 'deep'
            ? 180
            : 430 + Math.min(280, t * 0.8) + Math.sin(t * 0.3) * 5,
        uptimeSeconds: Math.floor((performance.now() - this.startedAtMs) / 1000),
      };
      this.emitStatus();
    }, 66);
  }

  /** Advance the simulated standby clock and return the status fields for it. */
  private tickStandby(): Pick<
    StatusState,
    | 'standbyStage'
    | 'standbyIdleSeconds'
    | 'standbyBlocked'
    | 'standbyEnabled'
    | 'standbyLightAfterMinutes'
    | 'standbyDeepAfterMinutes'
    | 'standbyWakeThresholdDb'
    | 'standbyWakeFailures'
  > {
    const settings = this.appSettings;
    const now = performance.now();
    const config = {
      standbyEnabled: settings.standbyEnabled,
      standbyLightAfterMinutes: settings.standbyLightAfterMinutes,
      standbyDeepAfterMinutes: settings.standbyDeepAfterMinutes,
      standbyWakeThresholdDb: settings.standbyWakeThresholdDb,
      standbyBlocked: false,
      standbyWakeFailures: [],
    };

    // A deep wake is an async plugin rebuild on the native side; stand in for it
    // so the progress overlay and the 'waking' stage are exercised here too.
    if (this.standbyWakeAtMs > 0) {
      if (now < this.standbyWakeAtMs) {
        return { ...config, standbyStage: 'waking', standbyIdleSeconds: 0 };
      }
      this.standbyWakeAtMs = 0;
      this.standbyLastActivityMs = now;
    }

    const idleSeconds = (now - this.standbyLastActivityMs) / 1000;
    if (!settings.standbyEnabled || this.rack.length === 0) {
      return { ...config, standbyStage: 'active', standbyIdleSeconds: idleSeconds };
    }

    const light = settings.standbyLightAfterMinutes * 60;
    const deep = settings.standbyDeepAfterMinutes * 60;
    if (deep > 0 && idleSeconds >= Math.max(deep, light)) {
      return { ...config, standbyStage: 'deep', standbyIdleSeconds: idleSeconds };
    }
    if (light > 0 && idleSeconds >= light) {
      return { ...config, standbyStage: 'light', standbyIdleSeconds: idleSeconds };
    }
    return { ...config, standbyStage: 'active', standbyIdleSeconds: idleSeconds };
  }

  /** Restart the simulated idle clock, waking if the mock had gone to sleep. */
  private noteStandbyActivity(): void {
    const wasDeep = this.status.standbyStage === 'deep';
    this.standbyLastActivityMs = performance.now();
    // Coming back from deep costs a visible rebuild, as it does natively.
    if (wasDeep) this.standbyWakeAtMs = performance.now() + 2000;
  }

  /** Simulated single-loop looper: real state machine, no audio. Mirrors the
      native LooperProcessor's transitions â€” including the mis-tap discard and
      the 60 s auto-close â€” so the widget behaves identically in the browser. */
  private looper = {
    state: 'empty' as LooperState,
    loopSeconds: 0,
    armStartMs: 0,
    recordStartMs: 0,
    playStartMs: 0,
    hasUndo: false,
    undoIsRedo: false,
    // The held loop is a loaded session nobody has modified â€” archiving it
    // again would only duplicate the entry, so the clear-time archive skips
    // it. Mirrors the native looper's isLoopUnchangedSinceLoad.
    unchangedLoad: false,
  };
  /** How long the mock stays armed before pretending the player's first note
      arrived â€” stands in for the engine's input-threshold trigger. */
  private static readonly MOCK_ARM_PICKUP_MS = 900;

  private metronomeBeatStartMs = performance.now();

  looperCommand(action: 'toggle' | 'stop' | 'clear' | 'undo'): void {
    this.noteStandbyActivity();
    const now = performance.now();
    const l = this.looper;
    // Recording -> a defined loop; a sub-100 ms take is a mis-tap and discards.
    const close = () => {
      l.loopSeconds = (now - l.recordStartMs) / 1000;
      if (l.loopSeconds < 0.1) {
        l.state = 'empty';
        l.loopSeconds = 0;
        return false;
      }
      return true;
    };
    switch (action) {
      case 'toggle':
        if (l.state === 'empty') {
          // Arm first (recording starts when the simulated input arrives),
          // unless auto-arm is off â€” then record on the press, as natively.
          if (this.status.looperArmEnabled) {
            l.state = 'armed';
            l.armStartMs = now;
          } else {
            l.state = 'recording';
            l.recordStartMs = now;
          }
          l.hasUndo = false;
        } else if (l.state === 'armed') {
          // Second press forces the take, as the engine does.
          l.state = 'recording';
          l.recordStartMs = now;
        } else if (l.state === 'recording') {
          if (close()) {
            l.state = 'playing';
            l.playStartMs = now;
          }
        } else if (l.state === 'playing') {
          l.state = 'overdubbing';
          l.hasUndo = false;
          l.unchangedLoad = false; // the session writes into the loop at once
        } else if (l.state === 'overdubbing') {
          l.state = 'playing';
          l.hasUndo = true;
          l.undoIsRedo = false;
        } else {
          l.state = 'playing';
          l.playStartMs = now;
        }
        break;
      case 'stop':
        if (l.state === 'armed') {
          l.state = 'empty'; // nothing captured yet: stop is a cancel
        } else if (l.state === 'recording') {
          if (close()) l.state = 'stopped';
        } else if (l.state === 'playing' || l.state === 'overdubbing') {
          if (l.state === 'overdubbing') l.hasUndo = true;
          l.state = 'stopped';
        }
        break;
      case 'clear':
        // Clear archives instead of discarding â€” a closed loop, or the
        // partial take recorded so far (mis-tap short ones excepted). An
        // unmodified loaded session is already on disk: skip the duplicate.
        if (!l.unchangedLoad) {
          this.archiveLooperSession(
            l.state === 'recording' ? (now - l.recordStartMs) / 1000 : l.loopSeconds,
          );
        }
        l.state = 'empty';
        l.loopSeconds = 0;
        l.hasUndo = false;
        l.undoIsRedo = false;
        l.unchangedLoad = false;
        break;
      case 'undo':
        // No audio to swap in the mock, but the parity is real: one press
        // undoes, the next redoes â€” the button label follows it.
        if (l.hasUndo && (l.state === 'playing' || l.state === 'stopped'))
          l.undoIsRedo = !l.undoIsRedo;
        break;
    }
    // Push immediately rather than waiting for the 66 ms tick: a pedal action
    // must feel instant, exactly like the native handler's echo.
    this.status = { ...this.status, ...this.tickLooper(now) };
    this.emitStatus();
  }

  private tickLooper(
    nowMs: number,
  ): Pick<
    StatusState,
    'looperState' | 'looperLengthSeconds' | 'looperPosition' | 'looperHasUndo' | 'looperUndoIsRedo'
  > {
    const l = this.looper;
    // The simulated player starts playing shortly after arming.
    if (l.state === 'armed' && nowMs - l.armStartMs >= MockEngine.MOCK_ARM_PICKUP_MS) {
      l.state = 'recording';
      l.recordStartMs = nowMs;
    }
    // The 60 s buffer limit auto-closes into playback, as the engine does.
    if (l.state === 'recording' && (nowMs - l.recordStartMs) / 1000 >= 60) {
      l.loopSeconds = 60;
      l.state = 'playing';
      l.playStartMs = nowMs;
    }
    let length = l.loopSeconds;
    let position = 0;
    if (l.state === 'recording') {
      length = (nowMs - l.recordStartMs) / 1000;
      position = length / 60;
    } else if ((l.state === 'playing' || l.state === 'overdubbing') && l.loopSeconds > 0) {
      position = (((nowMs - l.playStartMs) / 1000) % l.loopSeconds) / l.loopSeconds;
    }
    return {
      looperState: l.state,
      looperLengthSeconds: length,
      looperPosition: position,
      looperHasUndo: l.hasUndo,
      looperUndoIsRedo: l.undoIsRedo,
    };
  }

  metronomeCommand(action: 'toggle' | 'sync'): void {
    this.noteStandbyActivity();
    const now = performance.now();
    if (action === 'toggle') {
      this.status = { ...this.status, metronomeEnabled: !this.status.metronomeEnabled };
      if (this.status.metronomeEnabled) this.metronomeBeatStartMs = now;
    } else {
      this.metronomeBeatStartMs = now;
    }
    this.status = { ...this.status, ...this.tickMetronome(now) };
    this.emitStatus();
  }

  private tickMetronome(nowMs: number): Pick<StatusState, 'metronomeBeat' | 'metronomeBeatPhase'> {
    const bpm = this.status.metronomeBpm;
    const beats = this.status.metronomeBeatsPerBar;
    if (!this.status.metronomeEnabled || bpm <= 0 || beats <= 0) {
      return { metronomeBeat: 0, metronomeBeatPhase: 0 };
    }
    const elapsedBeats = ((Math.max(0, nowMs - this.metronomeBeatStartMs) / 1000) * bpm) / 60;
    const whole = Math.floor(elapsedBeats);
    return {
      metronomeBeat: whole % beats,
      metronomeBeatPhase: elapsedBeats - whole,
    };
  }

  // --- Looper session archive (metadata only â€” the mock has no audio) -------

  private looperSessions: LooperSession[] = loadStoredLooperSessions();
  private looperSessionListeners = new Set<(sessions: LooperSession[]) => void>();

  private archiveLooperSession(durationSeconds: number): void {
    if (durationSeconds < 0.1) return; // mis-tap, same floor as the engine
    const createdAt = Date.now();
    const id = uid('take');
    this.looperSessions = [
      {
        id,
        name: looperSessionName(createdAt),
        file: `${id}.wav`,
        durationSeconds,
        createdAt,
        kept: false,
      },
      ...this.looperSessions,
    ];
    this.pruneAndPersistLooperSessions();
  }

  private pruneAndPersistLooperSessions(): void {
    // No WAVs to delete in the mock; the prune only trims the list.
    this.looperSessions = pruneLooperSessions(
      this.looperSessions,
      this.appSettings.looperSessionAutoCleanup
        ? this.appSettings.looperSessionAutoCleanupLimit
        : Infinity,
    ).keep;
    this.persist(LOOPER_SESSIONS_KEY, this.looperSessions);
    for (const l of this.looperSessionListeners) l(this.looperSessions);
  }

  subscribeLooperSessions(listener: (sessions: LooperSession[]) => void): () => void {
    this.looperSessionListeners.add(listener);
    listener(this.looperSessions);
    return () => this.looperSessionListeners.delete(listener);
  }

  loadLooperSession(id: string): Promise<boolean> {
    const entry = this.looperSessions.find((s) => s.id === id);
    if (!entry) return Promise.resolve(false);
    const l = this.looper;
    // Archive whatever is held first, exactly like the native path â€” unless
    // it is itself an unmodified loaded session, already on disk.
    if (l.state !== 'empty' && l.state !== 'armed' && !l.unchangedLoad) {
      this.archiveLooperSession(
        l.state === 'recording' ? (performance.now() - l.recordStartMs) / 1000 : l.loopSeconds,
      );
    }
    const now = performance.now();
    l.state = 'playing';
    l.loopSeconds = entry.durationSeconds;
    l.playStartMs = now;
    l.hasUndo = false;
    l.undoIsRedo = false;
    l.unchangedLoad = true;
    this.status = { ...this.status, ...this.tickLooper(now) };
    this.emitStatus();
    return Promise.resolve(true);
  }

  deleteLooperSession(id: string): void {
    this.looperSessions = this.looperSessions.filter((s) => s.id !== id);
    this.persist(LOOPER_SESSIONS_KEY, this.looperSessions);
    for (const l of this.looperSessionListeners) l(this.looperSessions);
  }

  renameLooperSession(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed || !this.looperSessions.some((s) => s.id === id)) return;
    this.looperSessions = this.looperSessions.map((s) =>
      s.id === id ? { ...s, name: trimmed } : s,
    );
    this.persist(LOOPER_SESSIONS_KEY, this.looperSessions);
    for (const listener of this.looperSessionListeners) listener(this.looperSessions);
  }

  setLooperSessionKept(id: string, kept: boolean): void {
    this.looperSessions = this.looperSessions.map((s) => (s.id === id ? { ...s, kept } : s));
    // Un-keeping can push the list back over the cap.
    this.pruneAndPersistLooperSessions();
  }

  revealLooperSessions(): void {
    // Nothing to reveal in the browser.
  }

  standbyCommand(action: 'wake' | 'sleep' | 'activity'): void {
    if (action === 'sleep') {
      // Backdate the clock past the light timeout so standby engages now.
      this.standbyLastActivityMs =
        performance.now() - this.appSettings.standbyLightAfterMinutes * 60_000 - 1;
      return;
    }
    this.noteStandbyActivity();
  }

  /** A brand-new module for `pluginId`, dialled in from `patchId` when one was
      chosen. Shared by insertModule and replaceModule so a dropped tile builds
      the same module wherever it lands. */
  private buildModule(pluginId: string, patchId?: string): RackModule {
    const module = makeModule(pluginId);
    const patch = patchId ? this.findPatch(patchId) : undefined;
    if (!patch) return module;
    return {
      ...module,
      // The card's look travels with the mapping, as in loadPatch â€” a new
      // module has none of its own to keep. A patch with no title override
      // still names the card: the drawer tile showed the patch's name, and
      // the drop must produce the module the tile promised.
      displayName: patchTitleOverride(patch) ?? patch.name,
      color: patch.color ?? module.color,
      styleVariant: patch.styleVariant,
      icon: patch.icon,
      texture: patch.texture,
      tone3000: patch.tone3000,
      params: withMockState(knobsFromPatch(patch), patch.state),
    };
  }

  insertModule(pluginId: string, target: ModuleInsertTarget, patchId?: string): string | null {
    this.noteStandbyActivity();
    const module = this.buildModule(pluginId, patchId);

    const resolved = resolveInsert(this.rack, this.routing.groups, target);
    if (!resolved) return null;
    if (resolved.laneId) module.laneId = resolved.laneId;
    this.routing = { groups: resolved.groups };
    this.rack = [
      ...this.rack.slice(0, resolved.insertAt),
      module,
      ...this.rack.slice(resolved.insertAt),
    ];
    this.emit();
    return module.id;
  }

  subscribePlugins(listener: (plugins: PluginInfo[]) => void): () => void {
    this.pluginListeners.add(listener);
    listener(MOCK_PLUGINS);
    return () => this.pluginListeners.delete(listener);
  }

  removeModule(id: string): void {
    this.noteStandbyActivity();
    const index = this.rack.findIndex((m) => m.id === id);
    if (index < 0) return;

    const removedLaneId = this.rack[index].laneId;
    const removesLastLaneModule =
      !!removedLaneId && this.rack.filter((module) => module.laneId === removedLaneId).length === 1;
    if (!this.rack[index].laneId) {
      const serialIndex = this.rack.slice(0, index).filter((m) => !m.laneId).length;
      this.routing = {
        groups: this.routing.groups.map((g) =>
          g.position > serialIndex ? { ...g, position: g.position - 1 } : g,
        ),
      };
    }
    this.rack = this.rack.filter((m) => m.id !== id);

    if (removesLastLaneModule && removedLaneId) {
      const group = this.routing.groups.find((candidate) =>
        candidate.lanes.some((lane) => lane.id === removedLaneId),
      );
      if (group) {
        if (group.lanes.length <= 2) {
          const laneIds = new Set(group.lanes.map((lane) => lane.id));
          const restored = this.rack.filter(
            (module) => module.laneId && laneIds.has(module.laneId),
          ).length;
          const groupIndex = this.routing.groups.indexOf(group);
          this.rack = this.rack.map((module) =>
            module.laneId && laneIds.has(module.laneId) ? { ...module, laneId: undefined } : module,
          );
          this.routing = {
            groups: this.routing.groups
              .filter((candidate) => candidate.id !== group.id)
              .map((candidate, groupPosition) =>
                groupPosition >= groupIndex
                  ? { ...candidate, position: candidate.position + restored }
                  : candidate,
              ),
          };
        } else {
          const lanes = group.lanes.filter((lane) => lane.id !== removedLaneId);
          this.routing = {
            groups: this.routing.groups.map((candidate) =>
              candidate.id === group.id
                ? {
                    ...candidate,
                    lanes,
                    activeLaneId:
                      candidate.activeLaneId === removedLaneId
                        ? lanes[0]?.id
                        : candidate.activeLaneId,
                  }
                : candidate,
            ),
          };
        }
      }
    }
    this.emit();
  }

  replaceModule(moduleId: string, pluginId: string, patchId?: string): string | null {
    this.noteStandbyActivity();
    const index = this.rack.findIndex((m) => m.id === moduleId);
    if (index < 0) return null;

    // A swap in place: the module count and every serial position are
    // unchanged, so â€” unlike removeModule followed by insertModule â€” there is
    // no split arithmetic to do and no lane to collapse. The replacement
    // simply inherits the old module's lane.
    const module = this.buildModule(pluginId, patchId);
    module.laneId = this.rack[index].laneId;
    this.rack = this.rack.map((m, i) => (i === index ? module : m));
    this.emit();
    return module.id;
  }

  reorder(id: string, toIndex: number): void {
    const from = this.rack.findIndex((m) => m.id === id);
    if (from < 0) return;
    const next = [...this.rack];
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
    this.rack = next;
    this.emit();
  }

  moveModule(id: string, target: ModuleMoveTarget): void {
    // Moving into a brand-new lane: append the minted lane first, then run the
    // move as an ordinary anchor-less lane move targeting it.
    if (target.newLaneForGroupId) {
      const group = this.routing.groups.find(
        (candidate) => candidate.id === target.newLaneForGroupId,
      );
      if (!group) return;
      const lane = makeLane(nextLaneName(group.lanes));
      const groups = this.routing.groups.map((candidate) =>
        candidate.id === group.id ? { ...candidate, lanes: [...candidate.lanes, lane] } : candidate,
      );
      const result = moveModuleInRack(this.rack, groups, id, { laneId: lane.id });
      if (!result.changed) return; // unknown module â€” don't keep the orphan lane
      this.rack = result.rack;
      this.routing = { groups: result.groups };
      this.emit();
      return;
    }

    const result = moveModuleInRack(this.rack, this.routing.groups, id, target);
    if (!result.changed) return;
    this.rack = result.rack;
    this.routing = { groups: result.groups };
    this.emit();
  }

  swapModules(moduleIdA: string, moduleIdB: string): void {
    // No routing update: a swap leaves every group position untouched by
    // construction (see swapModulesInRack).
    const result = swapModulesInRack(this.rack, moduleIdA, moduleIdB);
    if (!result.changed) return;
    this.rack = result.rack;
    this.emit();
  }

  setBypass(id: string, bypassed: boolean): void {
    this.noteStandbyActivity();
    // Like setLaneSwitch: the real engine only reflects the toggle after a
    // bridge round-trip, so simulate that latency for the pending spinner.
    setTimeout(() => {
      this.rack = this.rack.map((m) => (m.id === id ? { ...m, bypassed } : m));
      this.emit();
    }, 400);
  }

  // --- Parallel routing (split / merge) -----------------------------------

  createSplit(atModuleId: string): void {
    const idx = this.rack.findIndex((m) => m.id === atModuleId);
    if (idx < 0 || this.rack[idx].laneId) return;
    // The split sits where this module was in the serial order; the module
    // becomes the first lane's contents, and a second empty lane joins it.
    const groupPosition = this.rack.slice(0, idx).filter((m) => !m.laneId).length;
    const laneA = makeLane(laneName(0));
    const laneB = makeLane(laneName(1));
    const before = this.routing.groups.filter((g) => g.position <= groupPosition);
    const after = this.routing.groups
      .filter((g) => g.position > groupPosition)
      .map((g) => ({ ...g, position: g.position - 1 }));
    // A split starts in switch mode on the lane that inherited the module, so
    // the chain sounds exactly as it did before the split; mix would suddenly
    // sum in an empty lane's dry signal.
    this.routing = {
      groups: [
        ...before,
        {
          id: uid('group'),
          position: groupPosition,
          lanes: [laneA, laneB],
          activeLaneId: laneA.id,
        },
        ...after,
      ],
    };
    this.rack = this.rack.map((m) => (m.id === atModuleId ? { ...m, laneId: laneA.id } : m));
    this.emit();
  }

  addLane(groupId: string): void {
    const target = this.routing.groups.find((g) => g.id === groupId);
    if (!target) return;
    const lane = makeLane(nextLaneName(target.lanes));
    this.routing = {
      groups: this.routing.groups.map((group) =>
        group.id === groupId ? { ...group, lanes: [...group.lanes, lane] } : group,
      ),
    };
    this.emit();
  }

  removeLane(laneId: string): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    // A removed lane takes its modules with it: the user is deleting a branch,
    // not rerouting it, so nothing falls back into the serial chain. Lane
    // modules never count toward a group's position, so no split arithmetic
    // moves for them.
    this.rack = this.rack.filter((m) => m.laneId !== laneId);
    if (group.lanes.length <= 2) {
      // Down to one lane there is nothing left to split: the group dissolves,
      // and only the surviving lane's modules return to the serial chain.
      const survivors = new Set(
        group.lanes.filter((lane) => lane.id !== laneId).map((lane) => lane.id),
      );
      const restored = this.rack.filter(
        (module) => module.laneId && survivors.has(module.laneId),
      ).length;
      this.rack = this.rack.map((module) =>
        module.laneId && survivors.has(module.laneId) ? { ...module, laneId: undefined } : module,
      );
      const groupIndex = this.routing.groups.indexOf(group);
      this.routing = {
        groups: this.routing.groups
          .filter((candidate) => candidate.id !== group.id)
          .map((candidate, index) =>
            index >= groupIndex
              ? { ...candidate, position: candidate.position + restored }
              : candidate,
          ),
      };
      this.emit();
      return;
    }
    const lanes = group.lanes.filter((l) => l.id !== laneId);
    this.routing = {
      groups: this.routing.groups.map((g) =>
        g.id === group.id
          ? { ...g, lanes, activeLaneId: g.activeLaneId === laneId ? lanes[0]?.id : g.activeLaneId }
          : g,
      ),
    };
    this.emit();
  }

  moveLane(laneId: string, toIndex: number): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    const from = group.lanes.findIndex((l) => l.id === laneId);
    const to = Math.max(0, Math.min(group.lanes.length - 1, toIndex));
    if (from === to) return;
    const lanes = [...group.lanes];
    lanes.splice(to, 0, ...lanes.splice(from, 1));
    this.routing = {
      groups: this.routing.groups.map((g) => (g.id === group.id ? { ...g, lanes } : g)),
    };
    this.emit();
  }

  renameLane(laneId: string, name: string): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    const index = group.lanes.findIndex((l) => l.id === laneId);
    const clean = name.trim() || laneName(index);
    this.routing = {
      groups: this.routing.groups.map((g) => ({
        ...g,
        lanes: g.lanes.map((l) => (l.id === laneId ? { ...l, name: clean } : l)),
      })),
    };
    this.emit();
  }

  setLaneMix(laneId: string, mix: Partial<Omit<LaneMix, 'id'>>): void {
    this.routing = {
      groups: this.routing.groups.map((g) => ({
        ...g,
        lanes: g.lanes.map((l) => (l.id === laneId ? { ...l, ...mix } : l)),
      })),
    };
    this.emit();
  }

  setLaneSwitch(groupId: string, activeLaneId: string | null): void {
    const group = this.routing.groups.find((candidate) => candidate.id === groupId);
    if (!group || (activeLaneId && !group.lanes.some((lane) => lane.id === activeLaneId))) return;
    // The real engine only reflects a switch after a bridge round-trip, so
    // simulate that latency; it keeps the UI's pending-spinner path exercised.
    setTimeout(() => {
      this.routing = {
        groups: this.routing.groups.map((candidate) =>
          candidate.id === groupId
            ? { ...candidate, activeLaneId: activeLaneId ?? undefined }
            : candidate,
        ),
      };
      this.emit();
    }, 400);
  }

  subscribeRouting(listener: (routing: RoutingState) => void): () => void {
    this.routingListeners.add(listener);
    listener(this.routing);
    return () => this.routingListeners.delete(listener);
  }

  subscribeBusy(listener: (state: EngineBusyState) => void): () => void {
    // The mock applies everything synchronously, so it is never busy.
    listener({ isBusy: false });
    return () => {};
  }

  subscribeToneDirty(listener: (dirty: boolean) => void): () => void {
    // Mock plugins have no native editors, so nothing can drift out of band.
    listener(false);
    return () => {};
  }

  private emitRouting(): void {
    for (const l of this.routingListeners) l(this.routing);
  }

  setParam(moduleId: string, paramIndex: number, value: number): void {
    this.noteStandbyActivity();
    const v = Math.max(0, Math.min(1, value));
    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            // Every knob pointed at this parameter reflects the new value.
            params: m.params.map((p) =>
              p.paramIndex === paramIndex ? { ...p, value: v, text: valueText(p.label, v) } : p,
            ),
          },
    );
    this.emit();
  }

  addKnob(moduleId: string, paramIndex: number, pos?: number): void {
    this.rack = this.rack.map((m) => {
      if (m.id !== moduleId) return m;
      const ref = m.availableParams.find((p) => p.index === paramIndex);
      if (!ref) return m;
      const bool = isBooleanParam(ref.name);
      const value = bool ? 0 : 0.5;
      const params = normalizePositions(m.params);
      const knob: MappedParam = {
        knobId: uid('knob'),
        paramIndex,
        label: ref.name,
        value,
        text: valueText(ref.name, value),
        isBoolean: bool,
        // Read-only params (meters/readouts) default to a meter display.
        isMeter: isReadOnlyParam(ref.name) || undefined,
        pos: pos ?? firstFreePos(params.map((p) => p.pos!)),
      };
      return { ...m, params: [...params, knob] };
    });
    this.emit();
  }

  removeKnob(moduleId: string, knobId: string): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId ? m : { ...m, params: m.params.filter((p) => p.knobId !== knobId) },
    );
    this.emit();
  }

  remapKnob(moduleId: string, knobId: string, paramIndex: number): void {
    this.rack = this.rack.map((m) => {
      if (m.id !== moduleId) return m;
      const ref = m.availableParams.find((p) => p.index === paramIndex);
      if (!ref) return m;
      return {
        ...m,
        params: m.params.map((p) =>
          p.knobId !== knobId
            ? p
            : {
                ...p,
                paramIndex,
                label: ref.name,
                value: isBooleanParam(ref.name) ? 0 : 0.5,
                text: valueText(ref.name, isBooleanParam(ref.name) ? 0 : 0.5),
                isBoolean: isBooleanParam(ref.name),
              },
        ),
      };
    });
    this.emit();
  }

  moveKnob(moduleId: string, knobId: string, pos: number): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId ? m : { ...m, params: moveKnobToPos(m.params, knobId, pos) },
    );
    this.emit();
  }

  renameKnob(moduleId: string, knobId: string, label: string): void {
    this.rack = this.rack.map((m) => {
      if (m.id !== moduleId) return m;
      return {
        ...m,
        params: m.params.map((p) => {
          if (p.knobId !== knobId) return p;
          // An empty name reverts to the plugin parameter's own name.
          const ref = m.availableParams.find((ap) => ap.index === p.paramIndex);
          return { ...p, label: label.trim() || ref?.name || p.label };
        }),
      };
    });
    this.emit();
  }

  setKnobMeter(moduleId: string, knobId: string, isMeter: boolean): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            params: m.params.map((p) =>
              p.knobId === knobId ? { ...p, ...knobMeterPatch(isMeter) } : p,
            ),
          },
    );
    this.emit();
  }

  setKnobMeterBipolar(moduleId: string, knobId: string, bipolar: boolean): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            params: m.params.map((p) =>
              p.knobId === knobId ? { ...p, meterBipolar: bipolar } : p,
            ),
          },
    );
    this.emit();
  }

  setKnobMidi(moduleId: string, knobId: string, trigger: MidiTrigger | null): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            params: m.params.map((p) =>
              p.knobId === knobId ? { ...p, midi: trigger ?? undefined } : p,
            ),
          },
    );
    this.emit();
  }

  setModuleMidi(moduleId: string, trigger: MidiTrigger | null): void {
    this.rack = this.rack.map((m) =>
      m.id !== moduleId ? m : { ...m, midi: trigger ?? undefined },
    );
    this.emit();
  }

  setLaneMidi(laneId: string, trigger: MidiTrigger | null): void {
    this.routing = {
      groups: this.routing.groups.map((g) => ({
        ...g,
        lanes: g.lanes.map((l) => (l.id === laneId ? { ...l, midi: trigger ?? undefined } : l)),
      })),
    };
    this.emitRouting();
    this.emit(); // persists the working snapshot (routing rides along)
  }

  renameModule(moduleId: string, name: string): void {
    const trimmed = name.trim();
    this.rack = this.rack.map((m) =>
      m.id !== moduleId ? m : { ...m, displayName: trimmed || undefined },
    );
    this.emit();
  }

  setModuleStyle(moduleId: string, style: ModuleStyleUpdate): void {
    this.rack = this.rack.map((m) => {
      if (m.id !== moduleId) return m;
      const next = { ...m };
      // Per field: undefined leaves the value alone, null clears it â€” same
      // guards as the real engine so both accept exactly the same values.
      if (style.color !== undefined)
        next.color = style.color === null ? undefined : asModuleColor(style.color);
      if (style.styleVariant !== undefined)
        next.styleVariant =
          style.styleVariant === null ? undefined : asStyleVariant(style.styleVariant);
      if (style.icon !== undefined)
        next.icon = style.icon === null ? undefined : asModuleIcon(style.icon);
      if (style.texture !== undefined)
        next.texture = style.texture === null ? undefined : asModuleTexture(style.texture);
      return next;
    });
    this.emit();
  }

  // Async to match the real engine, where capturing the tone is a round-trip
  // to the audio side; here it resolves immediately.
  async savePatch(moduleId: string, name: string): Promise<string | null> {
    // A preview must never be captured â€” JuceEngine's twin; see settlePreview.
    this.settlePreview(moduleId);
    const mod = this.rack.find((m) => m.id === moduleId);
    if (!mod) return null;
    const id = uid('patch');
    const doc = { ...storedFromModule(mod, name), tone3000: mod.tone3000, state: mockStateOf(mod) };
    this.writePatch(id, doc);
    this.retitleModule(moduleId, doc.name);
    return id;
  }

  async updatePatch(patchId: string, moduleId: string): Promise<void> {
    // Same rule as savePatch: never recapture a try-on.
    this.settlePreview(moduleId);
    const mod = this.rack.find((m) => m.id === moduleId);
    const existing = this.storedPatches[patchId];
    if (!mod || !existing) return;
    // Recapture the live mapping but keep the patch's identity: same id (so
    // whoever has it loaded stays pointed at it), same name, and the drawer
    // heading the user filed it under â€” storedFromModule knows nothing of the
    // category, so rebuilding the doc would silently drop it.
    this.writePatch(patchId, {
      ...storedFromModule(mod, existing.name),
      category: existing.category,
      tone3000: existing.tone3000,
      state: mockStateOf(mod),
    });
    this.retitleModule(moduleId, existing.name);
  }

  /** A save names the module â€” JuceEngine's twin: the card must say the saved
      name the moment the save lands, since the tile and the menu already do. */
  private retitleModule(moduleId: string, title: string): void {
    if (!this.rack.some((m) => m.id === moduleId && m.displayName !== title)) return;
    this.rack = this.rack.map((m) => (m.id !== moduleId ? m : { ...m, displayName: title }));
    this.emit();
  }

  loadPatch(moduleId: string, patchId: string): void {
    // Clicking a row commits the preview it was resting on, so the module it
    // would have been put back to is forgotten â€” see previewPatch.
    if (this.patchPreview?.moduleId === moduleId) this.patchPreview = null;
    this.applyPatch(moduleId, patchId, true);
  }

  previewPatch(moduleId: string, patchId: string): void {
    const mod = this.rack.find((m) => m.id === moduleId);
    if (!mod) return;
    // A run belongs to one module, and its snapshot is taken once: stepping
    // over to another module puts the first one back first. Modules are
    // replaced rather than mutated here, so holding the old one is the whole
    // snapshot â€” the real engine keeps the metadata half of it.
    if (this.patchPreview && this.patchPreview.moduleId !== moduleId) this.restorePreview();
    if (!this.patchPreview) this.patchPreview = { moduleId, module: mod };
    this.applyPatch(moduleId, patchId, false);
  }

  cancelPatchPreview(moduleId: string): void {
    if (this.patchPreview?.moduleId !== moduleId) return;
    this.restorePreview();
  }

  /** End any preview running on `moduleId` before a capture reads the module â€”
      what is captured must be the module's own state, never the try-on. */
  private settlePreview(moduleId: string): void {
    if (this.patchPreview?.moduleId === moduleId) this.restorePreview();
  }

  private restorePreview(): void {
    const run = this.patchPreview;
    this.patchPreview = null;
    if (!run) return;
    this.rack = this.rack.map((m) => (m.id === run.moduleId ? run.module : m));
    this.emit();
  }

  /** `withTone` is what separates a load from a preview: the mapping and look
      go on either way, the patch's saved values (this engine's stand-in for a
      plugin's own state) only on a real load. */
  private applyPatch(moduleId: string, patchId: string, withTone: boolean): void {
    const patch = this.findPatch(patchId);
    if (!patch) return;
    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            // The card's look travels with the mapping; a patch that carries
            // neither leaves the module's own name and colour alone. A TONE3000
            // patch always names the card â€” the tone is its identity.
            displayName: patchTitleOverride(patch) ?? m.displayName,
            color: patch.color ?? m.color,
            styleVariant: patch.styleVariant ?? m.styleVariant,
            icon: patch.icon ?? m.icon,
            texture: patch.texture ?? m.texture,
            // Unconditional, unlike the look: this is which tone is playing
            // now, so an ordinary patch loaded over a TONE3000 one clears it.
            tone3000: patch.tone3000,
            params: withTone
              ? withMockState(knobsFromPatch(patch), patch.state)
              : withLiveValues(knobsFromPatch(patch), m.params),
          },
    );
    this.emit();
  }

  renamePatch(patchId: string, name: string): void {
    const clean = name.trim();
    const existing = this.storedPatches[patchId];
    if (!clean || !existing) return;
    // The card title follows the name, as it does on save â€” JuceEngine's twin.
    this.writePatch(patchId, { ...existing, name: clean, displayName: clean });
  }

  setPatchCategory(patchId: string, category: string): void {
    const existing = this.storedPatches[patchId];
    if (!existing) return;
    // '' clears, so the heading goes back to being derived rather than
    // pinned to an empty one.
    this.writePatch(patchId, { ...existing, category: category.trim() || undefined });
  }

  deletePatch(patchId: string): void {
    if (!this.storedPatches[patchId]) return;
    const { [patchId]: _dropped, ...rest } = this.storedPatches;
    this.storedPatches = rest;
    this.persistPatches();
  }

  /** Both directories, the way the real engine reads them: the user's own
      first, then any pack's. The mutating paths deliberately see only
      `storedPatches`, so a shipped patch can never be written to. */
  private findPatch(patchId: string): StoredPatch | undefined {
    return this.storedPatches[patchId] ?? SHIPPED_PATCHES[patchId];
  }

  private writePatch(patchId: string, doc: StoredPatch): void {
    this.storedPatches = { ...this.storedPatches, [patchId]: doc };
    this.persistPatches();
  }

  subscribePatches(listener: (a: Patch[]) => void): () => void {
    this.patchListeners.add(listener);
    listener(mergePatches(patchList(this.storedPatches), SHIPPED_LIST));
    return () => this.patchListeners.delete(listener);
  }

  /** localStorage stands in for the disk here, so it carries the same contract
      as JuceEngine's writeFile: a failed write (quota, private mode) surfaces as
      a persistence error rather than vanishing. The in-memory copy is kept
      either way, so the session survives until the reload. */
  private persist(key: string, value: unknown): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      if (this.status.persistenceError === key) this.setPersistenceError(null);
      return true;
    } catch {
      this.setPersistenceError(key);
      return false;
    }
  }

  private setPersistenceError(key: string | null): void {
    if (this.status.persistenceError === key) return;
    this.status = { ...this.status, persistenceError: key };
    this.emitStatus();
  }

  // --- TONE3000 -------------------------------------------------------------
  // A scripted stand-in for the real integration: no network, no account, no
  // files. Browsing happens in a native window there is no equivalent of here,
  // so the mock plays the user's part too â€” it picks a tone and installs it, so
  // the splash, the install progress, the drawer tile and the missing-capture
  // repair can all be driven in the browser.

  private tone3000: Tone3000State = {
    connected: false,
    pending: false,
    apiAccess: 'none',
    splashSeen: false,
    downloads: [],
  };
  private tone3000Listeners = new Set<(state: Tone3000State) => void>();
  private tone3000InstallListeners = new Set<(event: Tone3000InstallEvent) => void>();

  subscribeTone3000(listener: (state: Tone3000State) => void): () => void {
    this.tone3000Listeners.add(listener);
    listener(this.tone3000);
    return () => this.tone3000Listeners.delete(listener);
  }

  refreshTone3000(): void {
    this.emitTone3000();
  }

  private emitTone3000(): void {
    for (const l of this.tone3000Listeners) l(this.tone3000);
  }

  tone3000Browse(options?: { moduleId?: string; pluginId?: string; architecture?: string }): void {
    // The real thing opens TONE3000's own window and waits on the user. There
    // is no window here, so the mock plays the whole thing through: connect,
    // pick a tone, download it. That is the flow the app now has â€” one click
    // and a patch appears â€” so it is the flow the browser dev loop reproduces.
    this.tone3000 = { ...this.tone3000, pending: true };
    this.emitTone3000();

    setTimeout(() => {
      this.tone3000 = {
        ...this.tone3000,
        pending: false,
        connected: true,
        apiAccess: 'prompt',
        user: { id: '1', username: 'you', avatarUrl: MOCK_TONES[0].creator.avatarUrl },
      };
      this.emitTone3000();

      // A different tone each time, so repeated clicks build a drawer full of
      // them rather than re-downloading one.
      const tone = MOCK_TONES[this.mockToneIndex++ % MOCK_TONES.length];
      // The standard-size model, which is what the engine's own rule
      // (Tone3000Library::chooseModel) arrives at for these fixtures. Not
      // reimplemented here: one copy of that rule, on the side that runs it.
      const model = mockModelsFor(tone.id)[0];
      this.installMockTone(tone, model, options?.moduleId);
    }, 500);
  }

  /** Which tone the next browse lands on. The mock's stand-in for a person
      choosing one. */
  private mockToneIndex = 0;

  private installMockTone(tone: Tone3000Tone, model: Tone3000Model, moduleId?: string): void {
    const runId = uid('t3k');
    const total = 4_200_000;
    let received = 0;

    const provenance: Tone3000Provenance = {
      toneId: tone.id,
      modelId: model.id,
      title: tone.title,
      gear: tone.gear,
      format: tone.format,
      modelName: model.name,
      size: model.size,
      architecture: model.architecture,
      creator: tone.creator,
      license: tone.license,
      url: tone.url,
      imageUrl: tone.imageUrl,
      file: `${tone.format === 'ir' ? 'ir' : 'nam'}/${tone.id}-${model.id}.${
        tone.format === 'ir' ? 'wav' : 'nam'
      }`,
      downloadedAt: new Date().toISOString(),
    };

    const tick = () => {
      received = Math.min(total, received + total / 6);
      this.emitTone3000Install({ runId, stage: 'downloading', received, total, title: tone.title });
      if (received < total) return void setTimeout(tick, 180);

      this.emitTone3000Install({ runId, stage: 'building', title: tone.title });
      setTimeout(() => {
        const module = moduleId ? this.rack.find((m) => m.id === moduleId) : undefined;

        // The same tone twice is one patch â€” JuceEngine's twin, with the doc in
        // hand rather than off disk, so there is no unreadable-document case.
        const existing = findTone3000Patch(
          Object.entries(this.storedPatches).map(([id, doc]) => ({ id, tone3000: doc.tone3000 })),
          provenance,
        );
        const patchId = existing?.id ?? uid('patch');
        const stored = existing ? this.storedPatches[existing.id] : undefined;

        if (stored) {
          // Only the take is written through, and only when the user picked
          // another one; everything else in the document is theirs.
          if (stored.tone3000?.modelId !== provenance.modelId)
            this.writePatch(patchId, {
              ...stored,
              state: `mock-t3k:${tone.id}-${model.id}`,
              tone3000: { ...provenance, models: provenance.models ?? stored.tone3000?.models },
            });
        } else {
          const base = module
            ? storedFromModule(module, provenance.title)
            : { name: provenance.title, pluginName: NAM_PLUGIN_NAME, knobs: [] };
          this.writePatch(patchId, {
            ...base,
            // The user's template (Settings â†’ TONE3000), copied â€” JuceEngine's twin.
            knobs:
              base.knobs.length > 0
                ? base.knobs
                : this.appSettings.tone3000TemplateKnobs.map((k) => ({ ...k })),
            name: provenance.title,
            // Never the capturing module's name â€” see JuceEngine's twin.
            displayName: undefined,
            state: `mock-t3k:${tone.id}-${model.id}`,
            tone3000: provenance,
          });
        }

        this.tone3000 = {
          ...this.tone3000,
          downloads: [
            ...this.tone3000.downloads.filter((d) => d.file !== provenance.file),
            { toneId: tone.id, modelId: model.id, file: provenance.file, bytes: total },
          ],
        };

        this.emitTone3000Install({ runId, stage: 'done', patchId });
        // The reconcile push, after the stream â€” the page believes this.
        this.emitTone3000();
        if (moduleId) this.loadPatch(moduleId, patchId);
      }, 300);
    };

    setTimeout(tick, 120);
  }

  tone3000Disconnect(): void {
    // Downloads survive a disconnect, exactly as they do natively: the models
    // and the patches made from them are the user's.
    this.tone3000 = { ...this.tone3000, connected: false, apiAccess: 'none', user: undefined };
    this.emitTone3000();
  }

  tone3000SplashSeen(): void {
    this.tone3000 = { ...this.tone3000, splashSeen: true };
    this.emitTone3000();
  }

  async tone3000SelectModel(moduleId: string, modelId: number): Promise<boolean> {
    // No files and no plugin state here, so the switch is the bookkeeping half
    // alone: the card says it is playing the other capture, which is what the
    // browser dev loop needs to exercise the switcher.
    const module = this.rack.find((m) => m.id === moduleId);
    const variant = module?.tone3000?.models?.find((v) => v.modelId === modelId);
    if (!module?.tone3000 || !variant) return false;

    this.rack = this.rack.map((m) =>
      m.id !== moduleId
        ? m
        : {
            ...m,
            tone3000: {
              ...m.tone3000!,
              modelId,
              modelName: variant.name,
              size: variant.size,
              architecture: variant.architecture,
              file: variant.file,
            },
          },
    );
    this.emit();
    return true;
  }

  tone3000CancelInstall(): void {}

  subscribeTone3000Install(listener: (event: Tone3000InstallEvent) => void): () => void {
    this.tone3000InstallListeners.add(listener);
    return () => this.tone3000InstallListeners.delete(listener);
  }

  private emitTone3000Install(event: Tone3000InstallEvent): void {
    for (const l of this.tone3000InstallListeners) l(event);
  }

  async tone3000Repair(patchId: string): Promise<boolean> {
    const doc = this.storedPatches[patchId];
    if (!doc?.tone3000) return false;
    this.tone3000 = {
      ...this.tone3000,
      downloads: [
        ...this.tone3000.downloads.filter((d) => d.file !== doc.tone3000!.file),
        {
          toneId: doc.tone3000.toneId,
          modelId: doc.tone3000.modelId,
          file: doc.tone3000.file,
          bytes: 4_200_000,
        },
      ],
    };
    this.emitTone3000();
    return true;
  }

  async tone3000Verify(): Promise<Set<string>> {
    const have = new Set(this.tone3000.downloads.map((d) => d.file));
    const patches = mergePatches(patchList(this.storedPatches), SHIPPED_LIST);
    const missing = patches
      .map((p) => p.tone3000?.file)
      .filter((f): f is string => !!f && !have.has(f));
    return patchesMissingCaptures(patches, missing);
  }

  private persistPatches(): void {
    // Only the user's own are persisted â€” SHIPPED_PATCHES stands in for a pack
    // on disk, which the app never writes.
    this.persist(PATCHES_KEY, this.storedPatches);
    const all = mergePatches(patchList(this.storedPatches), SHIPPED_LIST);
    for (const l of this.patchListeners) l(all);
  }

  /** The stored half of a rig â€” everything but its identity, cloned so the
      snapshot is independent of the live rack. */
  private captureRigBody() {
    return {
      modules: cloneModules(this.rack),
      routing: structuredClone(this.routing),
      scenes: structuredClone(this.scenes),
    };
  }

  saveRig(name: string): Promise<string | null> {
    const trimmed = name.trim() || nextRigName(this.rigs.map((r) => r.name));
    // Always a new rig: a name that another rig already uses is not a match,
    // since the id is the identity. Overwriting one is `updateRig`.
    const id = uid('rig');
    this.rigs = [...this.rigs, { id, name: trimmed, ...this.captureRigBody() }];
    return Promise.resolve(this.persistRigs() ? id : null);
  }

  updateRig(rigId: string): Promise<boolean> {
    if (!this.rigs.some((r) => r.id === rigId)) return Promise.resolve(false);
    // Content only â€” id, name and list position all stay put.
    this.rigs = this.rigs.map((r) => (r.id === rigId ? { ...r, ...this.captureRigBody() } : r));
    return Promise.resolve(this.persistRigs());
  }

  loadRig(rigId: string): Promise<boolean> {
    const rig = this.rigs.find((r) => r.id === rigId);
    if (!rig) return Promise.resolve(false);
    // Fresh ids so the loaded chain is independent of the stored snapshot.
    // laneId references LaneMix ids (restored below), not module ids, so it
    // survives the remint untouched. Scene entries key on module ids, so the
    // remint is recorded and the rig's scenes re-keyed through it.
    const idMap = new Map<string, string>();
    this.rack = cloneModules(rig.modules).map((m) => {
      const id = uid('mod');
      idMap.set(m.id, id);
      return withMissingState({
        ...m,
        id,
        params: m.params.map((p) => ({ ...p, knobId: uid('knob') })),
      });
    });
    this.routing = structuredClone(normalizeRoutingState(rig.routing));
    this.scenes = remapSceneIds(isSceneArray(rig.scenes) ? structuredClone(rig.scenes) : [], idMap);
    // The UI persists the new activeRigId before calling loadRig, so this
    // picks up the scene last used with the rig being loaded.
    this.activeSceneId = this.rememberedScene();
    this.emitScenes();
    this.emit();
    // Parity with JuceEngine: a load re-applies the remembered scene so its
    // stored values win over whatever the module snapshot carried. A no-op
    // here (mock snapshots are lossless), but it keeps both engines honouring
    // the same contract.
    if (this.activeSceneId) this.applyScene(this.activeSceneId);
    return Promise.resolve(true);
  }

  newRig(): void {
    this.rack = [];
    this.routing = { ...NO_ROUTING };
    this.scenes = [];
    this.activeSceneId = null;
    this.emitScenes();
    this.emit();
  }

  renameRig(rigId: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    const rig = this.rigs.find((r) => r.id === rigId);
    if (!rig) return;
    rig.name = clean;
    this.rigs = [...this.rigs];
    this.persistRigs();
  }

  deleteRig(rigId: string): void {
    this.rigs = this.rigs.filter((r) => r.id !== rigId);
    this.persistRigs();
  }

  moveRig(rigId: string, toIndex: number): void {
    const from = this.rigs.findIndex((r) => r.id === rigId);
    if (from < 0 || toIndex < 0 || toIndex >= this.rigs.length || toIndex === from) return;
    const rigs = [...this.rigs];
    rigs.splice(toIndex, 0, ...rigs.splice(from, 1));
    this.rigs = rigs;
    this.persistRigs();
  }

  subscribeRigs(listener: (r: Rig[]) => void): () => void {
    this.rigListeners.add(listener);
    listener(this.rigs.map(({ id, name }) => ({ id, name })));
    return () => this.rigListeners.delete(listener);
  }

  private persistRigs(): boolean {
    const ok = this.persist(RIGS_KEY, this.rigs);
    this.emitRigs();
    return ok;
  }

  private emitRigs(): void {
    // Hand out only the public {id, name} â€” the chain snapshot stays internal.
    const list: Rig[] = this.rigs.map(({ id, name }) => ({ id, name }));
    for (const l of this.rigListeners) l(list);
  }

  // --- Scenes (lightweight snapshots inside the current rig) ---------------

  saveScene(name: string): void {
    const scene = captureScene(
      name.trim() || `Scene ${this.scenes.length + 1}`,
      this.rack,
      this.routing,
    );
    this.scenes = [...this.scenes, scene];
    this.setActiveScene(scene.id);
    this.emitScenes();
    this.persistWorking();
  }

  updateScene(sceneId: string): void {
    const existing = this.scenes.find((s) => s.id === sceneId);
    if (!existing) return;
    const captured = captureScene(existing.name, this.rack, this.routing);
    this.scenes = this.scenes.map((s) =>
      s.id === sceneId ? { ...captured, id: s.id, name: s.name } : s,
    );
    this.setActiveScene(sceneId);
    this.emitScenes();
    this.persistWorking();
  }

  applyScene(sceneId: string): void {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;

    // One pass over the rack applies values and bypass together; unlike the
    // native engine there is no bridge round-trip, so the switch is immediate.
    const byModule = new Map(scene.modules.map((m) => [m.moduleId, m]));
    this.rack = this.rack.map((module) => {
      const entry = byModule.get(module.id);
      if (!entry) return module;
      const values = new Map(entry.params.map((p) => [p.paramIndex, p.value]));
      return {
        ...module,
        bypassed: entry.bypassed,
        params: module.params.map((p) => {
          const value = values.get(p.paramIndex);
          return value === undefined || p.isMeter
            ? p
            : { ...p, value, text: valueText(p.label, value) };
        }),
      };
    });

    const lanes = new Map(scene.lanes.map((l) => [l.laneId, l]));
    const switches = new Map(scene.switches.map((s) => [s.groupId, s]));
    this.routing = {
      groups: this.routing.groups.map((group) => {
        const sw = switches.get(group.id);
        return {
          ...group,
          activeLaneId: sw ? sw.activeLaneId : group.activeLaneId,
          lanes: group.lanes.map((lane) => {
            const mix = lanes.get(lane.id);
            return mix
              ? { ...lane, gain: mix.gain, pan: mix.pan, muted: mix.muted, soloed: mix.soloed }
              : lane;
          }),
        };
      }),
    };

    this.setActiveScene(sceneId);
    this.emitScenes();
    this.emit();
  }

  renameScene(sceneId: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.scenes = this.scenes.map((s) => (s.id === sceneId ? { ...s, name: clean } : s));
    this.emitScenes();
    this.persistWorking();
  }

  deleteScene(sceneId: string): void {
    this.scenes = this.scenes.filter((s) => s.id !== sceneId);
    if (this.activeSceneId === sceneId) this.setActiveScene(null);
    this.emitScenes();
    this.persistWorking();
  }

  moveScene(sceneId: string, toIndex: number): void {
    const from = this.scenes.findIndex((s) => s.id === sceneId);
    if (from < 0 || toIndex < 0 || toIndex >= this.scenes.length || toIndex === from) return;
    const scenes = [...this.scenes];
    scenes.splice(toIndex, 0, ...scenes.splice(from, 1));
    this.scenes = scenes;
    this.emitScenes();
    this.persistWorking();
  }

  subscribeScenes(listener: (state: SceneState) => void): () => void {
    this.sceneListeners.add(listener);
    listener(this.sceneState());
    return () => this.sceneListeners.delete(listener);
  }

  /** Adopt a scene as active and remember it for the current rig. The map in
      app settings is what brings the selection back after a rig switch or a
      restart â€” no user save involved. */
  private setActiveScene(sceneId: string | null): void {
    this.activeSceneId = sceneId;
    const rigId = this.appSettings.activeRigId;
    if (!rigId) return;
    const map = { ...this.appSettings.lastSceneByRig };
    if (sceneId) map[rigId] = sceneId;
    else delete map[rigId];
    this.setAppSettings({ lastSceneByRig: map });
  }

  /** The remembered scene for the current rig, if it still exists. */
  private rememberedScene(): string | null {
    const rigId = this.appSettings.activeRigId;
    const sceneId = rigId ? this.appSettings.lastSceneByRig[rigId] : undefined;
    return sceneId && this.scenes.some((s) => s.id === sceneId) ? sceneId : null;
  }

  private sceneState(): SceneState {
    return { scenes: structuredClone(this.scenes), activeSceneId: this.activeSceneId };
  }

  private emitScenes(): void {
    const state = this.sceneState();
    for (const l of this.sceneListeners) l(state);
  }

  openEditor(id: string): void {
    console.info('[mock] openEditor', id);
  }

  scanPlugins(): void {
    console.info('[mock] scanPlugins');
    this.pluginScan = { status: 'scanning', pluginCount: MOCK_PLUGINS.length };
    this.emitPluginScan();
    window.setTimeout(() => {
      this.pluginScan = { status: 'complete', pluginCount: MOCK_PLUGINS.length };
      this.emitPluginScan();
    }, 900);
  }

  subscribePluginScan(listener: (state: PluginScanState) => void): () => void {
    this.pluginScanListeners.add(listener);
    listener(this.pluginScan);
    return () => this.pluginScanListeners.delete(listener);
  }

  private emitPluginScan(): void {
    for (const listener of this.pluginScanListeners) listener(this.pluginScan);
  }

  subscribeBlacklistedPlugins(listener: (entries: BlacklistedPlugin[]) => void): () => void {
    this.blacklistListeners.add(listener);
    listener(this.blacklistedPlugins);
    return () => this.blacklistListeners.delete(listener);
  }

  refreshBlacklistedPlugins(): void {
    // Nothing to re-ask: the mock's list is held right here and already replayed.
  }

  retryBlacklistedPlugins(paths?: string[]): void {
    const clearing = paths?.length ? new Set(paths) : null;
    this.blacklistedPlugins = clearing
      ? this.blacklistedPlugins.filter((entry) => !clearing.has(entry.path))
      : [];
    for (const listener of this.blacklistListeners) listener(this.blacklistedPlugins);
    // A real retry rescans, which is what makes a cleared plugin reappear.
    this.scanPlugins();
  }

  // --- Plugin catalogue -----------------------------------------------------
  // A believable fake so the Packages panel is fully developable in the browser:
  // real-looking sizes, a package already installed, one with an update
  // pending, and one that always fails â€” the states the panel must handle are
  // otherwise only reachable by breaking a real download on purpose.

  subscribeCatalogue(listener: (state: CatalogueState) => void): () => void {
    this.catalogueListeners.add(listener);
    listener(this.catalogue);
    this.maybeAutoInstallStarter();
    return () => this.catalogueListeners.delete(listener);
  }

  subscribeStarterInstall(listener: (running: boolean) => void): () => void {
    this.starterInstallListeners.add(listener);
    listener(this.starterInstalling);
    return () => this.starterInstallListeners.delete(listener);
  }

  private setStarterInstalling(running: boolean): void {
    if (this.starterInstalling === running) return;
    this.starterInstalling = running;
    for (const listener of this.starterInstallListeners) listener(running);
  }

  /** See JuceEngine's copy: same rule, same one-shot flag. Settings are read
      synchronously here, so there is nothing to wait for. */
  private maybeAutoInstallStarter(): void {
    if (this.starterChecked) return;

    const decision = decideStarterAutoInstall(this.catalogue, this.appSettings);
    if (!decision.markAttempted) return;

    this.starterChecked = true;
    this.setAppSettings({ starterInstallAttempted: true });
    if (decision.install.length === 0) return;

    this.setStarterInstalling(true);
    this.installPackages(decision.install, STARTER_BUNDLE_ID, true);
  }

  refreshCatalogue(): void {
    // The mock's catalogue is held right here, so there is nothing to re-fetch
    // â€” but it still has to push, because a fresh `catalogueState` is the
    // only signal the panel gets that a refresh finished. Returning silently
    // left the browser exercising nothing but the panel's dropped-push timeout.
    // The delay stands in for the round trip a real fetch takes.
    window.setTimeout(() => this.emitCatalogue(), 600);
  }

  subscribeInstallProgress(listener: (event: InstallProgress) => void): () => void {
    this.installProgressListeners.add(listener);
    return () => this.installProgressListeners.delete(listener);
  }

  subscribeInstallFinished(listener: (result: InstallFinished) => void): () => void {
    this.installFinishedListeners.add(listener);
    return () => this.installFinishedListeners.delete(listener);
  }

  installPackages(requested: string[], bundleId?: string, rescanAll?: boolean): void {
    if (requested.length === 0 || this.catalogue.busy) return;
    this.runBundleId = bundleId ?? '';
    this.runRescanAll = rescanAll === true;

    // Dependencies first, as the native installer does: the caller asks for a
    // patch, and what runs is the plugin it names and then the patch.
    const ids = resolveInstallIds(requested, this.catalogue.items);

    this.catalogue = { ...this.catalogue, busy: true };
    this.emitCatalogue();

    const result: InstallFinished = {
      ok: true,
      installed: [],
      skipped: [],
      removed: [],
      failed: [],
      cancelled: false,
    };

    let delay = 0;
    const step = (event: Omit<InstallProgress, 'index' | 'count'>, index: number) => {
      delay += 260;
      window.setTimeout(() => {
        if (this.installCancelled) return;
        for (const listener of this.installProgressListeners)
          listener({ ...event, index: index + 1, count: ids.length });
      }, delay);
    };

    this.installCancelled = false;

    ids.forEach((id, index) => {
      const item = this.catalogue.items.find((i) => i.id === id);
      if (!item) return;

      const name = item.name;
      const total = item.downloadBytes;
      // MOCK_CATALOGUE_FAILING_ID exercises the failure path on every run,
      // so the retry affordance is never dead code in the browser.
      const fails = id === MOCK_CATALOGUE_FAILING_ID;

      for (const fraction of [0.25, 0.6, 1]) {
        step(
          { id, name, stage: 'downloading', received: Math.round(total * fraction), total },
          index,
        );
      }
      step({ id, name, stage: 'verifying', received: total, total }, index);

      if (fails) {
        step({ id, name, stage: 'failed', received: total, total, error: 'checksum' }, index);
        result.failed.push({ id, error: 'checksum' });
        result.ok = false;
      } else {
        step({ id, name, stage: 'extracting', received: total, total }, index);
        step({ id, name, stage: 'installed', received: total, total }, index);
        result.installed.push(id);
      }
    });

    window.setTimeout(() => {
      if (this.installCancelled) return;

      const installed = new Set(result.installed);
      const items = this.catalogue.items.map((item) =>
        installed.has(item.id)
          ? { ...item, installed: true, installedVersion: item.version, updateAvailable: false }
          : item,
      );

      // Bundles are derived from the plugin rows, never stored twice â€” the same
      // rule the native side follows. The bundle's own installedVersion is
      // recorded only when the whole run succeeded, so a partial install never
      // claims the user has that edition.
      const runBundleId = this.runBundleId;
      const fullyInstalled = result.failed.length === 0 && !result.cancelled;

      this.catalogue = {
        ...this.catalogue,
        busy: false,
        items,
        bundles: this.catalogue.bundles.map((p) =>
          this.deriveBundle(p, items, runBundleId, fullyInstalled),
        ),
      };
      this.runBundleId = '';

      this.setStarterInstalling(false);
      for (const listener of this.installFinishedListeners) listener(result);
      this.emitCatalogue();

      // A real install rescans, which is what makes the plugins appear â€” the
      // managed folder alone, except on the first run, which walks the whole
      // search path and so is worth doing even if nothing landed.
      const rescanAll = this.runRescanAll;
      this.runRescanAll = false;
      if (rescanAll || result.installed.length > 0) this.scanPlugins();
    }, delay + 260);
  }

  uninstallPackages(ids: string[]): void {
    if (ids.length === 0 || this.catalogue.busy) return;

    const removing = new Set(ids);
    this.catalogue = {
      ...this.catalogue,
      items: this.catalogue.items
        // An unlisted package only exists because it is installed, so removing
        // it takes the row with it â€” matching the native side, where the row
        // came from the install marker that was just deleted.
        .filter((item) => !(item.unlisted && removing.has(item.id)))
        .map((item) =>
          removing.has(item.id)
            ? { ...item, installed: false, installedVersion: '', updateAvailable: false }
            : item,
        ),
    };

    this.catalogue = {
      ...this.catalogue,
      bundles: this.catalogue.bundles.map((p) =>
        this.deriveBundle(p, this.catalogue.items, '', false),
      ),
    };

    for (const listener of this.installFinishedListeners)
      listener({
        ok: true,
        installed: [],
        skipped: [],
        removed: [...ids],
        failed: [],
        cancelled: false,
      });

    this.emitCatalogue();
    this.scanPlugins();
  }

  cancelInstall(): void {
    this.installCancelled = true;
    this.catalogue = { ...this.catalogue, busy: false };
    for (const listener of this.installFinishedListeners)
      listener({ ok: false, installed: [], skipped: [], removed: [], failed: [], cancelled: true });
    this.emitCatalogue();
  }

  /** Recomputes a bundle's install state from the package rows, mirroring what the
      native side derives. `justInstalledId` records the bundle's own edition only
      when the run that finished was for that bundle and fully succeeded. */
  private deriveBundle(
    bundle: CatalogueBundle,
    items: CataloguePackage[],
    justInstalledId: string,
    succeeded: boolean,
  ): CatalogueBundle {
    const byId = new Map(items.map((item) => [item.id, item]));

    const missingPackageIds = bundle.packageIds.filter((id) => !byId.get(id)?.installed);
    const outdatedPackageIds = bundle.packageIds.filter(
      (id) => byId.get(id)?.updateAvailable === true,
    );

    const installedVersion =
      justInstalledId === bundle.id && succeeded ? bundle.version : bundle.installedVersion;

    return {
      ...bundle,
      missingPackageIds,
      outdatedPackageIds,
      installedVersion,
      installed: missingPackageIds.length === 0,
      updateAvailable:
        installedVersion !== '' &&
        (installedVersion !== bundle.version || missingPackageIds.length > 0),
    };
  }

  private emitCatalogue(): void {
    for (const listener of this.catalogueListeners) listener(this.catalogue);
  }

  // --- Audio device -------------------------------------------------------
  // A plausible two-interface machine, so the setup wizard can be built and
  // exercised in a plain browser. The meters are synthetic: one channel carries
  // a "guitar" that answers to the page being clicked, the rest sit at a noise
  // floor â€” enough for the detection rule to have something to decide.

  subscribeAudioDevices(listener: (state: AudioDevicesState) => void): () => void {
    this.audioDeviceListeners.add(listener);
    listener(this.audioDevices);
    return () => this.audioDeviceListeners.delete(listener);
  }

  refreshAudioDevices(): void {
    this.emitAudioDevices();
  }

  setAudioDevice(change: AudioDeviceChange): void {
    const next = { ...this.audioDevices };
    if (change.driver !== undefined && change.driver !== next.driver) {
      const driver = MOCK_DRIVERS.find((d) => d.name === change.driver) ?? MOCK_DRIVERS[0];
      next.driver = driver.name;
      next.outputDevice = driver.outputDevices[0] ?? '';
      next.inputDevice = driver.inputDevices[0] ?? '';
      next.inputChannels = mockInputChannels(next.outputDevice);
      next.inputChannel = 0;
    }
    if (change.outputDevice !== undefined) {
      next.outputDevice = change.outputDevice;
      next.inputChannels = mockInputChannels(change.outputDevice);
      next.inputChannel = Math.min(next.inputChannel, Math.max(0, next.inputChannels.length - 1));
    }
    if (change.inputDevice !== undefined) next.inputDevice = change.inputDevice;
    if (change.sampleRate !== undefined) next.sampleRate = change.sampleRate;
    if (change.bufferSize !== undefined) next.bufferSize = change.bufferSize;
    if (change.inputChannel !== undefined) next.inputChannel = change.inputChannel;
    next.deviceLatencySamples = next.bufferSize * 2;
    this.audioDevices = next;
    // The engine's own reply, not an echo of the request: a mock that agreed
    // with everything asked of it would hide the reconciliation the real one
    // needs (a driver can refuse a rate and settle on another).
    this.status = { ...this.status, bufferSize: next.bufferSize, sampleRate: next.sampleRate };
    this.emitStatus();
    this.emitAudioDevices();
  }

  watchInputLevels(watching: boolean): void {
    if (this.inputLevelTimer !== undefined) {
      clearInterval(this.inputLevelTimer);
      this.inputLevelTimer = undefined;
    }
    if (!watching) return;

    this.inputLevelTimer = setInterval(() => {
      const channels = this.audioDevices.inputChannels.length;
      // Channel 1 is "the guitar": loud and moving. Everything else is a room
      // and a noise floor, which is what the detection rule has to see past.
      const peaks = Array.from({ length: channels }, (_, channel) =>
        channel === MOCK_GUITAR_CHANNEL
          ? 0.25 + 0.45 * Math.abs(Math.sin(Date.now() / 700))
          : 0.002 + Math.random() * 0.004,
      );
      for (const listener of this.inputLevelListeners) listener(peaks);
    }, 66);
  }

  subscribeInputLevels(listener: (peaks: number[]) => void): () => void {
    this.inputLevelListeners.add(listener);
    return () => this.inputLevelListeners.delete(listener);
  }

  private emitAudioDevices(): void {
    for (const listener of this.audioDeviceListeners) listener(this.audioDevices);
  }

  openAudioSettings(): void {
    console.info('[mock] openAudioSettings');
  }

  openExternalUrl(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  startWindowResize(edge: WindowResizeEdge): void {
    // The browser window is resized by the browser itself; nothing to do.
    console.info('[mock] startWindowResize', edge);
  }

  setEditorSize(width: number, height: number): void {
    // No plugin editor exists in a browser tab; the log is what lets the
    // grip be exercised under ?host=plugin in pnpm dev.
    console.info('[mock] setEditorSize', width, height);
  }

  setAppSettings(settings: Partial<AppSettings>): void {
    const cleanupChanged =
      settings.looperSessionAutoCleanup !== undefined ||
      settings.looperSessionAutoCleanupLimit !== undefined;
    this.appSettings = normalizeAppSettings({ ...this.appSettings, ...settings });
    this.persist(SETTINGS_KEY, this.appSettings);
    this.emitAppSettings();
    if (cleanupChanged) this.pruneAndPersistLooperSessions();
  }

  settingsReady(): Promise<void> {
    // localStorage is read synchronously in the field initialiser, so there is
    // nothing to wait for â€” the settings were never a promise here.
    return Promise.resolve();
  }

  subscribeAppSettings(listener: (settings: AppSettings) => void): () => void {
    this.appSettingsListeners.add(listener);
    listener(this.appSettings);
    return () => this.appSettingsListeners.delete(listener);
  }

  private emitAppSettings(): void {
    for (const listener of this.appSettingsListeners) listener(this.appSettings);
  }

  subscribeAppInfo(listener: (info: AppInfo) => void): () => void {
    listener(MOCK_APP_INFO);
    return () => {};
  }

  refreshAppInfo(): void {
    // Nothing to re-ask: the mock's facts are a constant, and subscribeAppInfo
    // already replayed them.
  }

  subscribeMidiEvents(listener: (events: MidiEvent[]) => void): () => void {
    this.midiEventListeners.add(listener);
    return () => this.midiEventListeners.delete(listener);
  }

  subscribeMidiDevices(listener: (devices: string[]) => void): () => void {
    listener(['Virtual mock input']);
    return () => {};
  }

  refreshMidiDevices(): void {
    // Constant, already replayed by subscribeMidiDevices.
  }

  /** Browser-console hook for exercising MIDI learn and dispatch without
      hardware: `plectrifyInjectMidi({type:'cc', channel:1, number:25, value:127})`. */
  injectMidi(events: MidiEvent[]): void {
    if (events.length === 0) return;
    for (const listener of this.midiEventListeners) listener(events);
  }

  setStatus(status: Partial<SettableStatus>): void {
    this.noteStandbyActivity();
    this.status = { ...this.status, ...status };
    this.emitStatus();
  }

  subscribeStatus(listener: (status: StatusState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }

  subscribeRack(listener: (rack: RackModule[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.rack);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // Every structural mutation funnels through here, so this one call keeps
    // scenes mirroring the rack (see `reconcileScenes`) â€” and runs before the
    // save below, so the persisted snapshot captures reconciled scenes.
    this.reconcileLiveScenes();
    for (const l of this.listeners) l(this.rack);
    // Rack and routing frequently change together (split/dissolve/move), so a
    // rack emit always refreshes routing subscribers too.
    this.emitRouting();
    this.persistWorking();
  }

  /** Prune scene entries whose module/knob/lane/group is gone; backfill new
      ones from live state. Mock values are always authoritative, so no
      known-value gate is needed (unlike JuceEngine). */
  private reconcileLiveScenes(): void {
    if (this.scenes.length === 0) return;
    const { scenes, changed } = reconcileScenes(this.scenes, this.rack, this.routing);
    if (!changed) return;
    this.scenes = scenes;
    this.emitScenes();
  }

  private snapshot(): WorkingSnapshot {
    return {
      modules: cloneModules(this.rack),
      routing: structuredClone(this.routing),
      scenes: structuredClone(this.scenes),
    };
  }

  private persistWorking(): void {
    this.persist(WORKING_KEY, this.snapshot());
  }
}
