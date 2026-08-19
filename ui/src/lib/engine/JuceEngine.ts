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
  BlacklistedPlugin,
  EngineBusyState,
  LooperSession,
  MidiEvent,
  MidiTrigger,
  Patch,
  LaneMix,
  MappedParam,
  ParamRef,
  PluginInfo,
  RackLoadingProgress,
  Rig,
  RackModule,
  RoutingState,
  Scene,
  SceneState,
  StatusState,
} from './types';
import {
  LOOPER_SESSION_DIR,
  LOOPER_SESSION_INDEX,
  looperSessionName,
  normalizeLooperSessions,
  pruneLooperSessions,
} from './looperSessions';
import { sanitizeTrigger } from './midi';
import type { ModuleIcon, ModuleStyleVariant, ModuleTexture } from './moduleAppearance';
import { asModuleColor, asModuleIcon, asModuleTexture, asStyleVariant } from './moduleAppearance';
import { knobMeterPatch } from './contentMidi';
import { DEFAULT_APP_INFO, DEFAULT_STATUS_STATE, EMPTY_AUDIO_DEVICES } from './types';
import { normalizeAudioDevices } from './audioDevices';
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from './appSettings';
import { firstFreePos, moveKnobToPos, normalizePositions } from './knobLayout';
import { laneName, makeLane, nextLaneName, normalizeRoutingState } from './routing';
import {
  LEGACY_INDEX_FILE,
  LEGACY_PATCH_DIR,
  PATCH_DIR,
  byName,
  isStoredPatch,
  legacyPatchIdsFrom,
  legacyPatchPath,
  mergePatches,
  patchIdsFrom,
  patchPath,
  patchTitleOverride,
  sharedPatchIdsFrom,
  storedFromModule,
  toPatch,
  type StoredPatch,
} from './patches';
import { nextRigName } from './rigNames';
import { isStaleEcho, notePendingParamWrite, type PendingEchoes } from './paramEcho';
import {
  EMPTY_CATALOGUE_STATE,
  normalizeInstallFinished,
  normalizeInstallProgress,
  normalizeCatalogueState,
  type InstallFinished,
  type InstallProgress,
  type CatalogueState,
} from './catalogue';
import { decideStarterAutoInstall, STARTER_BUNDLE_ID } from './starterBundle';
import type { Tone3000InstallEvent, Tone3000Provenance, Tone3000State } from './tone3000';
import {
  findTone3000Patch,
  isTone3000Provenance,
  NAM_PLUGIN_NAME,
  patchesMissingCaptures,
  referencedFiles,
} from './tone3000';
import {
  SCENE_VALUE_EPSILON,
  captureScene,
  isSceneArray,
  reconcileScenes,
  remapSceneIds,
} from './scenes';
import { uid } from './ids';

interface JuceBackend {
  emitEvent(id: string, payload: unknown): void;
  addEventListener(id: string, fn: (data: unknown) => void): number;
  removeEventListener(token: number): void;
}

const RIG_DIR = 'rigs';
const RIG_INDEX = `${RIG_DIR}/index.json`;
const SESSION_FILE = 'lastSession.rig';
const WORKING_FILE = 'working-rack.json';
/** Written by older builds that kept an undo timeline; read once for
    migration, then deleted. */
const LEGACY_HISTORY_FILE = 'working-history.json';
const SETTINGS_FILE = 'settings.json';
/** On disk only while a session restore is in flight. Present at startup =
    the previous launch died mid-restore (plugins and drivers load in-process
    and can crash the host), so that session must not be restored again. */
const RESTORE_SENTINEL = 'restore_in_progress';
const WORKING_QUARANTINE = 'working-rack.quarantine.json';

/** Deadline for a bridge request's reply. Replies travel over
    emitEventIfBrowserIsVisible, so one CAN be dropped (e.g. during a page
    reload); without a deadline a single lost reply would wedge the serialized
    session-save chain forever. */
const REQUEST_TIMEOUT_MS = 15_000;
/** applyRig instantiates plugins one by one with message-loop yields in
    between, so a large rig of heavy plugins is legitimately slow. */
const APPLY_RIG_TIMEOUT_MS = 120_000;
const LANE_MIX_EMIT_INTERVAL_MS = 30;
/** How long a failed session autosave waits before trying again. The retry runs
    off the same timer as an ordinary edit, so it needs a floor — a lasting
    failure (a full disk) would otherwise reschedule itself at 0 ms forever. */
const SESSION_SAVE_RETRY_MS = 5_000;

/** Grace windows during which pluginStateChanged is NOT treated as plugin-
    internal drift, because the notification is an echo of a write this side
    just made (setValueNotifyingHost / setStateInformation report back through
    the host's AudioProcessorListener). Sized to outlast the native 15 Hz
    coalescing tick (~66 ms) with margin. */
const TONE_DIRTY_PARAM_GRACE_MS = 500;
/** Scene applies echo through the same coalesced plugin-change listener as
    whole-rack applies, so they share the longer window. */
const TONE_DIRTY_SCENE_GRACE_MS = 1_500;
/** Some plugins fire updateHostDisplay merely on their editor opening. */
const TONE_DIRTY_EDITOR_GRACE_MS = 1_000;
/** Whole-rack applies keep notifying briefly after the busy latch drops. */
const TONE_DIRTY_APPLY_GRACE_MS = 1_500;
/** A patch's state blob goes in through setStateInformation, which notifies
    like a scene apply and can trail further notifications while a plugin
    finishes loading whatever the blob named (a capture, an impulse). */
const TONE_DIRTY_STATE_GRACE_MS = 2_000;

/** On-disk rig index entry: the public {id, name} plus the file that holds the
    chain snapshot. Kept out of the `Rig` type so the UI never sees the path. */
interface RigEntry extends Rig {
  file: string;
}

/** The audio-truth half of a module, reported by C++. Everything here is a
    property of the live plugin/graph; none of it is user metadata. */
interface NodeInfo {
  id: string; // the shared clientId
  name: string;
  bypassed: boolean;
  /** The slot is a placeholder for a plugin that failed to load. See
      `RackModule.missing`. */
  missing?: boolean;
  availableParams: ParamRef[];
  laneId?: string;
  // Plugin identity for the About dialog's diagnostics; absent while the
  // module's plugin is unloaded (deep standby).
  pluginVersion?: string;
  pluginManufacturer?: string;
}

interface RackSnapshot {
  revision: string;
  modules: NodeInfo[];
  routing: RoutingState;
}

/** One knob in the TS-owned metadata: which plugin parameter, under what label,
    at what position (array order). No live value — that streams from C++. */
interface KnobMeta {
  knobId: string;
  paramIndex: number;
  label: string;
  /** Whether the mapping is shown as a read-only meter. See `MappedParam.isMeter`. */
  isMeter?: boolean;
  /** Whether the meter fills from the centre (bipolar). See `MappedParam.meterBipolar`. */
  meterBipolar?: boolean;
  /** Column-major cell on the module's 2-row knob grid. See `knobLayout.ts`. */
  pos?: number;
  /** Learned MIDI trigger driving this knob's parameter. See `MappedParam.midi`. */
  midi?: MidiTrigger;
}

/** The metadata-truth half of a module, owned and persisted by TS. Keyed by
    clientId and joined against the matching NodeInfo to build a RackModule. */
interface ModuleMeta {
  displayName?: string;
  /** User-chosen accent colour (hex). See `RackModule.color`. */
  color?: string;
  /** Style variant, icon and texture. See the matching `RackModule` fields. */
  styleVariant?: ModuleStyleVariant;
  icon?: ModuleIcon;
  texture?: ModuleTexture;
  /** Learned MIDI press trigger toggling the module's bypass. See `RackModule.midi`. */
  midi?: MidiTrigger;
  /** The TONE3000 tone loaded onto this module. See `RackModule.tone3000`. */
  tone3000?: Tone3000Provenance;
  knobs: KnobMeta[];
}

/** One module as written to a rig/session snapshot: TS metadata merged with the
    opaque C++ tone blob. TS never parses `state`. */
interface StoredModule extends ModuleMeta {
  clientId: string;
  description: string;
  state: string;
  bypassed: boolean;
  laneId?: string;
}

interface StoredRack {
  modules: StoredModule[];
  routing?: RoutingState;
  /** The rig's scenes, keyed by the stored modules' clientIds (absent in old
      files). Re-keyed whenever the snapshot is applied and ids are re-minted.
      Which scene is *active* is deliberately not stored here — that's
      workspace state, remembered per rig in the app settings. */
  scenes?: Scene[];
}

/** A live parameter value keyed by paramIndex (two knobs on one param share it). */
interface ParamValue {
  value: number;
  text?: string;
}

/** Filesystem-safe stem from a rig name (the human name is preserved inside
    the file; this only shapes the filename). */
const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'rig';

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isStoredRack(value: unknown): value is StoredRack {
  const rack = value as Partial<StoredRack> | null;
  return (
    Array.isArray(rack?.modules) &&
    rack.modules.every(
      (module) =>
        typeof module?.description === 'string' &&
        typeof module?.state === 'string' &&
        typeof module?.bypassed === 'boolean' &&
        Array.isArray(module?.knobs),
    ) &&
    (rack.scenes === undefined || isSceneArray(rack.scenes))
  );
}

function isRigEntryArray(value: unknown): value is RigEntry[] {
  const entries = value as Array<Partial<RigEntry>> | null;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        typeof entry?.id === 'string' &&
        typeof entry?.name === 'string' &&
        typeof entry?.file === 'string',
    )
  );
}

function backend(): JuceBackend | undefined {
  return (window as unknown as { __JUCE__?: { backend?: JuceBackend } }).__JUCE__?.backend;
}

/** The host kind the engine baked into window.__JUCE__ before this page's
    first script ran (withInitialisationData). The same fact rides the appInfo
    push, but a push can be dropped while the view is hidden — which is how a
    DAW may open an editor — and the session-restore decision is one-shot:
    mistaking a plugin for the standalone applies the standalone's autosaved
    working rack over the DAW's session. Absent on an engine older than the
    field. */
function bootHostKind(): 'standalone' | 'plugin' | undefined {
  const pushed = (window as unknown as { __JUCE__?: { initialisationData?: { host?: unknown[] } } })
    .__JUCE__?.initialisationData?.host;
  const kind = Array.isArray(pushed) ? pushed[0] : undefined;
  return kind === 'standalone' || kind === 'plugin' ? kind : undefined;
}

/** bootHostKind as an AppInfo fragment: an absent answer contributes no `host`
    key at all, keeping "engine older than the field" indistinguishable from
    the default it always meant. */
function hostSeed(): Pick<AppInfo, 'host'> {
  const kind = bootHostKind();
  return kind === undefined ? {} : { host: kind };
}

/** True when running inside the JUCE WebBrowserComponent. */
export function juceAvailable(): boolean {
  return backend() !== undefined;
}

type ValueUpdate = { id: string; params: Array<{ paramIndex: number } & ParamValue> };

/** Value→text lookup tables pushed via `paramTexts` for every watched param. */
type TextUpdate = { id: string; params: Array<{ paramIndex: number; texts: string[] }> };

/**
 * EngineBridge backed by the real JUCE audio engine, over the event-only
 * window.__JUCE__ bridge.
 *
 * The audio/metadata split: C++ owns only what touches audio — the ordered node
 * list (`rackChanged`), live parameter values (`paramValues`), and plugin tone
 * blobs. TS owns all metadata — knob mappings + order, display names, and
 * patches — keyed by a TS-generated `clientId` and joined with the node
 * list to produce the `RackModule[]` the UI consumes. This keeps the C++ bridge
 * surface minimal: knob edits never cross the boundary.
 */
export class JuceEngine implements EngineBridge {
  private rack: RackModule[] = [];
  private listeners = new Set<(rack: RackModule[]) => void>();

  // The preview run in flight, if any: which module's patch menu is being
  // walked, and the metadata — mapping, look, provenance — it had before the
  // first row was previewed. Snapshotted once per run, never per patch, so
  // walking the menu still returns to where the run started. The plugin's own
  // tone is deliberately *not* part of a preview: swapping it is a round-trip
  // to the audio side per row, and a rig previewing itself out loud on every
  // pointer move is not something a player can hear past. Not persisted — a
  // preview is a pointer resting on a row, and nothing that survives a launch.
  private patchPreview: { moduleId: string; meta: ModuleMeta } | null = null;

  // Audio truth (from C++), metadata truth (owned here), and live values.
  private nodes: NodeInfo[] = [];
  private meta = new Map<string, ModuleMeta>();

  /** Resolved by the first appInfo push. Its `host` field decides where the
      working session lives (working-rack.json vs the engine's document), so
      the session restore waits here before touching either location. Declared
      before the promise: property initializers run in order. */
  private appInfoSeen = false;
  private resolveAppInfoKnown: () => void = () => {};
  private appInfoKnown = new Promise<void>((resolve) => {
    this.resolveAppInfoKnown = resolve;
  });
  /** A DAW project reload pushed a new session document while this editor was
      open; adoption waits for the engine's rack apply to report done. */
  private pendingSessionAdoption = false;
  private values = new Map<string, Map<number, ParamValue>>();
  // Value→text tables (from C++'s paramTexts, re-sent on every watch change).
  // Lets optimistic writes show the plugin's formatted value immediately
  // instead of a stale string that lags the knob until the next stream tick.
  private texts = new Map<string, Map<number, string[]>>();
  // Guards the one-shot migration for racks created by older builds whose
  // page-local id counter could collide after a WebView reload.
  private repairingDuplicateNodeIds = false;

  // Parallel routing and lane membership are native-owned audio truth.
  private routing: RoutingState = { groups: [] };
  /** Lane names, keyed by lane id. C++ tracks only audio truth, so it echoes
      lanes back unnamed; this overlay is what makes a name outlive the echo
      (and therefore survive reordering, which is a C++-side permutation). */
  private laneNames = new Map<string, string>();
  // Same overlay pattern for the lanes' MIDI triggers: TS-only lane metadata
  // that every C++ routing echo would otherwise wipe (buildRoutingState emits
  // audio truth only). Re-stamped alongside names in withLaneMeta.
  private laneMidi = new Map<string, MidiTrigger>();
  private rackRevision = -1n;
  private routingListeners = new Set<(r: RoutingState) => void>();
  private laneMixPending = new Map<string, Partial<Omit<LaneMix, 'id'>>>();
  private laneMixTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Optimistic param writes awaiting their engine echo — see paramEcho.ts.
  private pendingParamEcho: PendingEchoes = new Map();
  private status: StatusState = { ...DEFAULT_STATUS_STATE };
  private statusListeners = new Set<(status: StatusState) => void>();
  private appSettings = { ...DEFAULT_APP_SETTINGS };
  private appSettingsListeners = new Set<(settings: AppSettings) => void>();
  // Seeded with the boot-baked host kind so isPluginHost() answers right from
  // the first frame — its other callers (the session autosave target, the DAW
  // reload adoption) run before any appInfo push can land. The push re-states
  // the same fact.
  private appInfo: AppInfo = { ...DEFAULT_APP_INFO, ...hostSeed() };
  private appInfoListeners = new Set<(info: AppInfo) => void>();
  // Raw MIDI trigger stream (a stream, not state — nothing replays) and the
  // auto-opened input list (state — the last push replays on subscribe).
  private midiEventListeners = new Set<(events: MidiEvent[]) => void>();
  private midiDevices: string[] = [];
  private midiDeviceListeners = new Set<(devices: string[]) => void>();
  // The audio device choice (state — replays) and the wizard's per-channel
  // input meters (a stream — nothing replays, and nothing arrives at all
  // unless watchInputLevels has armed the engine's probe).
  private audioDevices: AudioDevicesState = { ...EMPTY_AUDIO_DEVICES };
  private audioDeviceListeners = new Set<(state: AudioDevicesState) => void>();
  private inputLevelListeners = new Set<(peaks: number[]) => void>();
  private appSettingsRevision = 0;
  /** Serializes this page's own settings.json rewrites; see persistAppSettings. */
  private appSettingsChain: Promise<void> = Promise.resolve();
  private appSettingsLoaded: Promise<void> = Promise.resolve();

  // The user's own patches. Mapping only — a patch's tone stays on disk and
  // is read when it is loaded, since a rack's worth of captures has no
  // business sitting in memory all session.
  private patches: Patch[] = [];
  // Kept apart from `patches` rather than merged into it: the mutating paths
  // all work off that list, so a merged pack could be renamed, updated or
  // deleted — writing into the shared root, or copying a pack's patch into
  // the user's own folder where it would outlive uninstalling the pack.
  private shippedPatches: Patch[] = [];
  private patchListeners = new Set<(a: Patch[]) => void>();

  // Plugins the host can instantiate (from C++, refreshed after a scan).
  private plugins: PluginInfo[] = [];
  private pluginListeners = new Set<(p: PluginInfo[]) => void>();
  private pluginScan: PluginScanState = { status: 'idle', pluginCount: 0 };
  private pluginScanListeners = new Set<(state: PluginScanState) => void>();
  // Plugin files the scanner skips; empty until the engine's first push lands.
  private blacklistedPlugins: BlacklistedPlugin[] = [];
  private blacklistListeners = new Set<(entries: BlacklistedPlugin[]) => void>();

  private catalogue: CatalogueState = EMPTY_CATALOGUE_STATE;
  private catalogueListeners = new Set<(state: CatalogueState) => void>();
  /** The first-run starter-bundle question, asked at most once per session:
      set as soon as it has an answer, so a second catalogue push (a refresh,
      or the one that ends the run) cannot start a second run before
      settings.json has come back saying the first one happened. */
  private starterChecked = false;
  private starterInstalling = false;
  private starterInstallListeners = new Set<(running: boolean) => void>();
  private installProgressListeners = new Set<(event: InstallProgress) => void>();
  private installFinishedListeners = new Set<(result: InstallFinished) => void>();
  // Patches to apply to a module once its clientId appears in the rack,
  // keyed by clientId — set when adding a module with a mapping pre-selected.
  private pendingPatch = new Map<string, string>();

  // Rigs live as files on disk (C++ owns only tone capture/apply + file I/O);
  // the rig list, names and working-session logic are owned here.
  private rigEntries: RigEntry[] = [];
  private rigListeners = new Set<(r: Rig[]) => void>();
  /** Serializes this page's own index rewrites; see mutateRigIndex. */
  private rigIndexChain: Promise<void> = Promise.resolve();

  // Looper session archive: C++ writes the WAVs and announces each save;
  // the index (names, order, kept flags) is owned here, rigs-style.
  private looperSessions: LooperSession[] = [];
  private looperSessionListeners = new Set<(sessions: LooperSession[]) => void>();

  // Scenes belong to the current rig/working rack: lightweight snapshots of
  // mapped parameter values, bypass, and lane state. Owned here; the scene
  // *list* is persisted inside every StoredRack (rig files, the working
  // session) while the *active* pointer lives in app settings, per rig.
  private scenes: Scene[] = [];
  private activeSceneId: string | null = null;
  private sceneListeners = new Set<(s: SceneState) => void>();

  // Request/response over the otherwise broadcast-only bridge.
  private pending = new Map<string, (data: unknown) => void>();
  private fileReadChunks = new Map<string, string[]>();

  // Working-session autosave: debounced whole-rack captures written to disk so
  // the next launch can restore the session. Capture requests stay serialized
  // behind the JUCE event bridge. Starts busy until the restore finishes.
  private busy = true;
  private busyListeners = new Set<(state: EngineBusyState) => void>();
  private rackLoading: RackLoadingProgress | undefined;
  private sessionReady = false;
  private applyingRack = false;
  private sessionDirty = false;
  private sessionSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionSaveChain: Promise<void> = Promise.resolve();

  // Plugin-internal drift ("tone dirty"): a hosted plugin changed its own
  // state — an edit in its native editor, a program switch — since the rig was
  // last saved or loaded. Invisible to the rack signature the UI diffs, but
  // captured by a rig save. Latched until a save or whole-rack apply clears
  // it; echoes of this side's own writes are ignored via grace windows.
  private toneDirty = false;
  private toneDirtyListeners = new Set<(dirty: boolean) => void>();
  // Bumped on every raise; save paths snapshot it before the capture/write
  // round-trip so drift that lands mid-write stays flagged.
  private toneDirtyEpoch = 0;
  private suppressToneDirtyUntil = 0;

  constructor() {
    const b = backend();
    b?.addEventListener('rackChanged', (data) => {
      if (Array.isArray(data)) {
        this.nodes = data as NodeInfo[];
      } else {
        const snapshot = data as RackSnapshot;
        const revision = BigInt(snapshot?.revision ?? '0');
        if (revision < this.rackRevision) return;
        this.rackRevision = revision;
        this.nodes = snapshot?.modules ?? [];
        this.routing = this.withLaneMeta(normalizeRoutingState(snapshot?.routing));
        this.emitRouting();
      }
      if (this.hasInvalidNodeIds()) {
        // Startup restoration rekeys the rack itself. Only start an explicit
        // live repair after that restore attempt has finished, avoiding two
        // overlapping native apply operations.
        if (this.sessionReady) void this.repairInvalidNodeIds();
        return;
      }
      this.pruneMeta();
      this.applyPendingPatches();
      this.rebuild();
      this.reconcileLiveScenes();
      if (this.sessionDirty && !this.applyingRack) this.scheduleSessionSave(0);
    });
    b?.addEventListener('pluginsChanged', (data) => {
      this.plugins = (data as PluginInfo[]) ?? [];
      this.emitPlugins();
    });
    b?.addEventListener('pluginScanChanged', (data) => {
      const next = data as Partial<PluginScanState>;
      const status = next.status;
      if (status !== 'scanning' && status !== 'complete') return;
      this.pluginScan = {
        status,
        pluginCount: Math.max(0, Number(next.pluginCount) || 0),
      };
      this.emitPluginScan();
    });
    b?.addEventListener('pluginBlacklistChanged', (data) => {
      this.blacklistedPlugins = Array.isArray(data)
        ? (data as Partial<BlacklistedPlugin>[]).filter(
            (e): e is BlacklistedPlugin =>
              typeof e?.path === 'string' && typeof e?.name === 'string',
          )
        : [];
      this.emitBlacklistedPlugins();
    });
    b?.addEventListener('catalogueState', (data) => {
      this.catalogue = normalizeCatalogueState(data);
      this.emitCatalogue();
      // Disk truth, and the reason the running flag does not depend on the
      // installFinished stream having arrived (it rides
      // emitEventIfBrowserIsVisible, and a first-run download is long enough
      // for the window to be occluded across the whole of it).
      if (!this.catalogue.busy) this.setStarterInstalling(false);
      // A fresh installation fetches the starter bundle by itself, and this
      // push is the first moment there is a catalogue to fetch it from.
      void this.maybeAutoInstallStarter();
      // Installing or removing a pack changes what is on the shared root, and
      // this push is the disk truth the panel already reconciles against — so
      // it is also the right moment to re-read the packs, rather than trusting
      // the installFinished stream to have arrived.
      void this.refreshShippedPatches();
    });
    b?.addEventListener('installProgress', (data) => {
      const event = normalizeInstallProgress(data);
      if (event) for (const listener of this.installProgressListeners) listener(event);
    });
    b?.addEventListener('installFinished', (data) => {
      const result = normalizeInstallFinished(data);
      this.setStarterInstalling(false);
      for (const listener of this.installFinishedListeners) listener(result);
    });
    // Static host facts. Answered once, from the boot request below. The
    // `host` field also decides where the working session lives (see
    // readWorkingSession), so the first arrival resolves the gate the session
    // restore waits behind.
    b?.addEventListener('appInfo', (data) => {
      // hostSeed under the push: the boot-baked host kind stays the floor even
      // if a push ever arrives without the field.
      this.appInfo = { ...DEFAULT_APP_INFO, ...hostSeed(), ...(data as Partial<AppInfo>) };
      this.appInfoSeen = true;
      this.resolveAppInfoKnown();
      this.emitAppInfo();
    });
    // The engine's session document changed under the page: a DAW project
    // reload pushed new state into the plugin while this editor was open. The
    // engine is rebuilding the rack; adopt the new metadata once its apply
    // reports done (see the rigApplyProgress listener), not now — a partial
    // rack echo would prune the incoming mappings.
    b?.addEventListener('sessionChanged', () => {
      if (!this.isPluginHost()) return;
      this.pendingSessionAdoption = true;
      this.applyingRack = true;
      // Belt and braces: if the done event is dropped (occluded window), the
      // adoption must not wedge autosaves forever. Past the engine's own
      // 120 s apply watchdog, adopt whatever state has settled.
      setTimeout(() => {
        if (this.pendingSessionAdoption) {
          this.pendingSessionAdoption = false;
          void this.finishSessionAdoption();
        }
      }, 130_000);
    });
    b?.addEventListener('pluginStateChanged', (data) => {
      this.markSessionDirty(500);
      const changed = data as { params?: boolean; state?: boolean } | undefined;
      if (!changed?.params && !changed?.state) return;
      if (!this.sessionReady || this.applyingRack || this.busy) return;
      // Standby parks/wakes plugin state entirely native-side.
      if (this.status.standbyStage !== 'active') return;
      if (performance.now() < this.suppressToneDirtyUntil) return;
      this.raiseToneDirty();
    });
    b?.addEventListener('rigApplyProgress', (data) => {
      const progress = data as {
        done?: boolean;
        current?: number;
        total?: number;
        pluginName?: string;
      };
      this.rackLoading = progress.done
        ? undefined
        : {
            current: Math.max(0, Number(progress.current) || 0),
            total: Math.max(0, Number(progress.total) || 0),
            pluginName: progress.pluginName || undefined,
          };
      this.emitBusy();
      // A DAW-driven state load finished rebuilding the rack: now the new
      // session document can be adopted against the settled module list.
      if (progress.done && this.pendingSessionAdoption) {
        this.pendingSessionAdoption = false;
        void this.finishSessionAdoption();
      }
    });
    b?.addEventListener('paramValues', (data) => this.applyValues(data as ValueUpdate[]));
    b?.addEventListener('paramTexts', (data) => this.applyTexts(data as TextUpdate[]));
    b?.addEventListener('statusChanged', (data) => {
      const prevStage = this.status.standbyStage;
      const update = {
        ...(data as Partial<StatusState> & { metronomePattern?: unknown }),
      };
      if (
        typeof update.metronomePattern === 'string' &&
        /^[0-3]{1,18}$/.test(update.metronomePattern)
      ) {
        update.metronomeAccents = [...update.metronomePattern].map((level) => Number(level));
      }
      delete update.metronomePattern;
      this.status = { ...this.status, ...update };
      // A deep-standby wake re-applies plugin state natively; the plugins'
      // change notifications trailing it are not user edits.
      if (prevStage !== 'active' && this.status.standbyStage === 'active')
        this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
      this.emitStatus();
    });
    b?.addEventListener('midiEvents', (data) => {
      if (!Array.isArray(data)) return;
      const events = (data as Partial<MidiEvent>[]).filter(
        (e): e is MidiEvent =>
          (e?.type === 'cc' || e?.type === 'pc' || e?.type === 'note') &&
          typeof e.channel === 'number' &&
          typeof e.number === 'number' &&
          typeof e.value === 'number',
      );
      if (events.length === 0) return;
      for (const listener of this.midiEventListeners) listener(events);
    });
    b?.addEventListener('midiDevicesChanged', (data) => {
      const devices = (data as { devices?: unknown })?.devices;
      this.midiDevices = Array.isArray(devices)
        ? devices.filter((d): d is string => typeof d === 'string')
        : [];
      for (const listener of this.midiDeviceListeners) listener(this.midiDevices);
    });
    b?.addEventListener('audioDevicesChanged', (data) => {
      this.audioDevices = normalizeAudioDevices(data);
      for (const listener of this.audioDeviceListeners) listener(this.audioDevices);
    });
    b?.addEventListener('inputLevels', (data) => {
      const peaks = (data as { peaks?: unknown })?.peaks;
      if (!Array.isArray(peaks)) return;
      const values = peaks.map((peak) => (typeof peak === 'number' && peak >= 0 ? peak : 0));
      for (const listener of this.inputLevelListeners) listener(values);
    });
    // Replies to request/response calls (captureRig, readFile) resolve here.
    b?.addEventListener('rigCaptured', (data) => this.resolvePending(data));
    b?.addEventListener('rigApplied', (data) => this.resolvePending(data));
    b?.addEventListener('moduleStateCaptured', (data) => this.resolvePending(data));
    b?.addEventListener('fileRead', (data) => this.resolvePending(data));
    b?.addEventListener('fileReadChunk', (data) => this.resolveFileReadChunk(data));
    b?.addEventListener('filesListed', (data) => this.resolvePending(data));
    b?.addEventListener('fileWritten', (data) => this.resolvePending(data));
    b?.addEventListener('sessionRead', (data) => this.resolvePending(data));
    b?.addEventListener('sessionWritten', (data) => this.resolvePending(data));
    b?.addEventListener('looperSessionSaved', (data) => this.onLooperSessionSaved(data));
    b?.addEventListener('looperSessionLoaded', (data) => this.resolvePending(data));
    b?.addEventListener('tone3000State', (data) => this.onTone3000State(data));
    b?.addEventListener('tone3000ModelSelected', (data) => this.resolvePending(data));
    b?.addEventListener('tone3000Verified', (data) => this.resolvePending(data));
    b?.addEventListener('tone3000Repaired', (data) => this.resolvePending(data));
    b?.addEventListener('tone3000Connected', (data) => this.onTone3000Connected(data));
    b?.addEventListener('tone3000InstallProgress', (data) => this.onTone3000InstallProgress(data));
    b?.addEventListener('tone3000InstallFinished', (data) => this.onTone3000InstallFinished(data));

    b?.emitEvent('requestRack', {});
    b?.emitEvent('requestPlugins', {});
    b?.emitEvent('requestPluginBlacklist', {});
    b?.emitEvent('requestStatus', {});
    b?.emitEvent('requestAppInfo', {});
    b?.emitEvent('requestMidiDevices', {});
    b?.emitEvent('requestTone3000', {});
    // The input probe lives in the engine and outlives this document, so a page
    // reloaded (dev HMR, a WebView recovery) while the wizard's input step was
    // open would leave it metering every channel for nobody. Nothing here ever
    // arms it — the wizard does — so disarming on boot is always right.
    b?.emitEvent('watchInputLevels', { watching: false });

    // Load small metadata files and restore the working session. Large session
    // reads are compressed and chunked by the native bridge. Session restore
    // waits for the settings (they hold the remembered per-rig scene).
    void this.refreshPatches();
    void this.refreshShippedPatches();
    void this.refreshRigs();
    void this.refreshLooperSessions();
    this.appSettingsLoaded = this.refreshAppSettings();
    void this.restorePreviousSession();
  }

  insertModule(pluginId: string, target: ModuleInsertTarget, patchId?: string): string | null {
    // TS mints the shared id up front; C++ stamps it on the created slot. When
    // a mapping was chosen, remember it so it's applied once the node echoes back.
    const clientId = uid('mod');
    if (patchId) this.pendingPatch.set(clientId, patchId);
    this.markSessionDirty();
    // A module built from scratch wants its plugin editor straight away; one
    // built from a patch arrives already dialled in, so leave it closed.
    backend()?.emitEvent('insertModule', {
      clientId,
      pluginId,
      openEditor: patchId === undefined,
      ...target,
    });
    return clientId;
  }

  replaceModule(moduleId: string, pluginId: string, patchId?: string): string | null {
    // Same shape as insertModule — TS mints the replacement's id and remembers
    // the patch to apply once the new node echoes back — except the position
    // is not a gap but the module being replaced, which C++ resolves at the
    // moment the plugin finishes loading.
    const clientId = uid('mod');
    if (patchId) this.pendingPatch.set(clientId, patchId);
    this.markSessionDirty();
    backend()?.emitEvent('replaceModule', {
      id: moduleId,
      clientId,
      pluginId,
      openEditor: patchId === undefined,
    });
    return clientId;
  }

  subscribePlugins(listener: (plugins: PluginInfo[]) => void): () => void {
    this.pluginListeners.add(listener);
    listener(this.plugins);
    return () => {
      this.pluginListeners.delete(listener);
    };
  }

  removeModule(id: string): void {
    this.markSessionDirty();
    backend()?.emitEvent('removeModule', { id });
  }

  reorder(id: string, toIndex: number): void {
    this.markSessionDirty();
    backend()?.emitEvent('reorder', { id, toIndex });
  }

  moveModule(id: string, target: ModuleMoveTarget): void {
    // Fire-and-forget like reorder: C++ resolves the (pre-move) coordinates in
    // RackProcessor::moveSlot and truth comes back as the rackChanged echo.
    if (target.newLaneForGroupId) {
      // Moving into a brand-new lane: mint the lane TS-side like addLane, so
      // its name survives the unnamed C++ echoes.
      const group = this.routing.groups.find((g) => g.id === target.newLaneForGroupId);
      if (!group) return;
      const lane = makeLane(nextLaneName(group.lanes));
      this.laneNames.set(lane.id, lane.name);
      this.markSessionDirty();
      backend()?.emitEvent('moveModule', { id, newLaneGroupId: group.id, newLaneId: lane.id });
      return;
    }
    const { laneId, beforeModuleId, serialPosition, beforeGroupId } = target;
    this.markSessionDirty();
    backend()?.emitEvent('moveModule', {
      id,
      laneId,
      beforeModuleId,
      serialPosition,
      beforeGroupId,
    });
  }

  swapModules(moduleIdA: string, moduleIdB: string): void {
    // Fire-and-forget like moveModule: RackProcessor::swapSlots does the whole
    // exchange in one graph edit and truth comes back as the rackChanged echo.
    // Both modules keep their client ids, so every mapping, binding and scene
    // value already pointing at them follows without a fixup here.
    this.markSessionDirty();
    backend()?.emitEvent('swapModules', { a: moduleIdA, b: moduleIdB });
  }

  setBypass(id: string, bypassed: boolean): void {
    this.markSessionDirty();
    backend()?.emitEvent('setBypass', { id, bypassed });
    // Some plugins fire their change listener when (un)bypassed — an echo of
    // this write, not tone drift, so it must not raise toneDirty (which would
    // force the next discard onto the full-reload path).
    this.suppressToneDirty(TONE_DIRTY_PARAM_GRACE_MS);
  }

  setParam(moduleId: string, paramIndex: number, value: number): void {
    // Clamp like the engine (and MockEngine) do, so the optimistic local value
    // can never disagree with what the plugin will actually report back.
    const clamped = Math.max(0, Math.min(1, value));
    // Optimistic local update so knobs feel instant; the engine confirms via paramValues.
    // Derive the readout from the cached text table so it tracks the drag; fall
    // back to the last streamed text — a text-less entry would leave the
    // readout blank until the next paramValues tick.
    const cur = this.values.get(moduleId)?.get(paramIndex);
    notePendingParamWrite(
      this.pendingParamEcho,
      moduleId,
      paramIndex,
      clamped,
      cur?.value,
      performance.now(),
    );
    this.setValue(moduleId, paramIndex, {
      value: clamped,
      text: this.textFor(moduleId, paramIndex, clamped) ?? cur?.text,
    });
    this.rebuild();
    backend()?.emitEvent('setParam', { moduleId, paramIndex, value: clamped });
    // The engine echoes this write back through the plugin-change listener;
    // repeated drag events keep the window extended.
    this.suppressToneDirty(TONE_DIRTY_PARAM_GRACE_MS);
    this.markSessionDirty(300);
  }

  // --- Knob mapping (pure metadata, owned entirely here) ------------------

  addKnob(moduleId: string, paramIndex: number, pos?: number): void {
    const ap = this.paramRef(moduleId, paramIndex);
    if (!ap) return; // param the current plugin doesn't expose
    const m = this.metaFor(moduleId);
    const knobs = normalizePositions(m.knobs);
    m.knobs = [
      ...knobs,
      {
        knobId: uid('knob'),
        paramIndex,
        label: ap.name,
        // Read-only params (meters/readouts) default to a meter display.
        isMeter: ap.isReadOnly || undefined,
        pos: pos ?? firstFreePos(knobs.map((k) => k.pos!)),
      },
    ];
    this.afterMetaChange(moduleId, true);
  }

  removeKnob(moduleId: string, knobId: string): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.filter((k) => k.knobId !== knobId);
    this.afterMetaChange(moduleId, true);
  }

  remapKnob(moduleId: string, knobId: string, paramIndex: number): void {
    const ap = this.paramRef(moduleId, paramIndex);
    if (!ap) return;
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.map((k) => (k.knobId === knobId ? { ...k, paramIndex, label: ap.name } : k));
    this.afterMetaChange(moduleId, true);
  }

  moveKnob(moduleId: string, knobId: string, pos: number): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = moveKnobToPos(m.knobs, knobId, pos);
    this.afterMetaChange(moduleId, false); // cell change: watch set unchanged
  }

  renameKnob(moduleId: string, knobId: string, label: string): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.map((k) => {
      if (k.knobId !== knobId) return k;
      // A blank label reverts to the plugin parameter's own name.
      const fallback = this.paramRef(moduleId, k.paramIndex)?.name ?? k.label;
      return { ...k, label: label.trim() || fallback };
    });
    this.afterMetaChange(moduleId, false);
  }

  setKnobMeter(moduleId: string, knobId: string, isMeter: boolean): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.map((k) => (k.knobId === knobId ? { ...k, ...knobMeterPatch(isMeter) } : k));
    this.afterMetaChange(moduleId, false); // meter flag + binding: watch set unchanged
  }

  setKnobMeterBipolar(moduleId: string, knobId: string, bipolar: boolean): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.map((k) => (k.knobId === knobId ? { ...k, meterBipolar: bipolar } : k));
    this.afterMetaChange(moduleId, false); // display mode only: watch set unchanged
  }

  setKnobMidi(moduleId: string, knobId: string, trigger: MidiTrigger | null): void {
    const m = this.meta.get(moduleId);
    if (!m) return;
    m.knobs = m.knobs.map((k) => (k.knobId === knobId ? { ...k, midi: trigger ?? undefined } : k));
    this.afterMetaChange(moduleId, false); // binding only: watch set unchanged
  }

  renameModule(moduleId: string, name: string): void {
    const m = this.metaFor(moduleId);
    m.displayName = name.trim() || undefined;
    this.afterMetaChange(moduleId, false);
  }

  setModuleStyle(moduleId: string, style: ModuleStyleUpdate): void {
    const m = this.metaFor(moduleId);
    // Per field: undefined leaves the value alone, null clears it. Values are
    // run through the appearance guards so only known ids (and well-formed
    // colours — they end up in an inline style) reach the meta.
    if (style.color !== undefined)
      m.color = style.color === null ? undefined : asModuleColor(style.color);
    if (style.styleVariant !== undefined)
      m.styleVariant = style.styleVariant === null ? undefined : asStyleVariant(style.styleVariant);
    if (style.icon !== undefined)
      m.icon = style.icon === null ? undefined : asModuleIcon(style.icon);
    if (style.texture !== undefined)
      m.texture = style.texture === null ? undefined : asModuleTexture(style.texture);
    this.afterMetaChange(moduleId, false);
  }

  setModuleMidi(moduleId: string, trigger: MidiTrigger | null): void {
    const m = this.metaFor(moduleId);
    m.midi = trigger ?? undefined;
    this.afterMetaChange(moduleId, false);
  }

  // --- Patches (one file each: mapping and tone together) ---

  // --- TONE3000 -------------------------------------------------------------
  // The engine owns the account, the network and the downloads; this side owns
  // the patch document, which is where the split has always been. A downloaded
  // tone becomes an ordinary patch - same file, same drawer, same rig recall.

  private tone3000State: Tone3000State = {
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
    listener(this.tone3000State);
    return () => this.tone3000Listeners.delete(listener);
  }

  refreshTone3000(): void {
    backend()?.emitEvent('requestTone3000', {});
  }

  private onTone3000State(data: unknown): void {
    this.tone3000State = data as Tone3000State;
    for (const l of this.tone3000Listeners) l(this.tone3000State);
  }

  private onTone3000Connected(data: unknown): void {
    // Only a failure is worth surfacing here: a *successful* pick continues
    // natively into the download, which reports on the install stream. The
    // engine's own state push covers everything else.
    const done = data as { ok?: boolean; error?: string };
    if (done.ok === false && done.error)
      this.onTone3000Install({ runId: 'connect', stage: 'failed', error: done.error });
  }

  tone3000Browse(options?: { moduleId?: string; pluginId?: string; architecture?: string }): void {
    backend()?.emitEvent('tone3000Connect', { ...options });
  }

  tone3000Disconnect(): void {
    backend()?.emitEvent('tone3000Disconnect', {});
  }

  tone3000SplashSeen(): void {
    backend()?.emitEvent('tone3000SplashSeen', {});
  }

  /** The engine rewrites the module's live plugin state to point at another of
      the tone's captures and hands it back; applying it and updating what the
      card says it is playing are this side's job, exactly as with a patch. */
  async tone3000SelectModel(moduleId: string, modelId: number): Promise<boolean> {
    const meta = this.meta.get(moduleId);
    const provenance = meta?.tone3000;
    if (!provenance) return false;

    const variant = provenance.models?.find((m) => m.modelId === modelId);

    const res = (await this.request('tone3000SelectModel', {
      moduleId,
      toneId: provenance.toneId,
      modelId,
      format: provenance.format,
    })) as { ok?: boolean; state?: string; file?: string };

    if (!res.ok || !res.state || !meta) return false;

    // The card now says it is playing that capture: same tone, same credit,
    // different take. `file` comes from the engine rather than from the variant
    // list, so a patch written before that list existed still ends up correct.
    meta.tone3000 = {
      ...provenance,
      modelId,
      modelName: variant?.name ?? provenance.modelName,
      size: variant?.size ?? provenance.size,
      architecture: variant?.architecture ?? provenance.architecture,
      file: res.file ?? variant?.file ?? provenance.file,
    };

    // Same guards a patch load takes: the echo guard has no business here, and
    // the plugin's own notifications must not read as the user editing a tone.
    this.pendingParamEcho.delete(moduleId);
    this.suppressToneDirty(TONE_DIRTY_STATE_GRACE_MS);
    backend()?.emitEvent('applyModuleState', { moduleId, state: res.state });
    this.afterMetaChange(moduleId, false);
    this.markSessionDirty(0);
    return true;
  }

  tone3000CancelInstall(): void {
    backend()?.emitEvent('tone3000CancelInstall', {});
  }

  subscribeTone3000Install(listener: (event: Tone3000InstallEvent) => void): () => void {
    this.tone3000InstallListeners.add(listener);
    return () => this.tone3000InstallListeners.delete(listener);
  }

  private onTone3000Install(event: Tone3000InstallEvent): void {
    for (const l of this.tone3000InstallListeners) l(event);
  }

  private onTone3000InstallProgress(data: unknown): void {
    this.onTone3000Install(data as Tone3000InstallEvent);
  }

  /** The engine has the model on disk and the rewritten plugin state; the patch
      document is written here, through the same sandboxed writeFile every other
      patch uses. Nothing about the patch format lives natively.

      The provenance arrives with the event rather than being held here by run
      id, because the run is no longer this side's to start: the user picked the
      tone on TONE3000's own pages and the engine is the only thing that ever
      saw it. */
  private onTone3000InstallFinished(data: unknown): void {
    const done = data as {
      runId: string;
      ok?: boolean;
      error?: string;
      path?: string;
      state?: string;
      moduleId?: string;
      file?: string;
      provenance?: Tone3000Provenance;
    };

    if (!done.ok || !done.state || !isTone3000Provenance(done.provenance)) {
      this.onTone3000Install({
        runId: done.runId,
        stage: 'failed',
        error: done.error,
        path: done.path,
      });
      return;
    }

    const provenance = { ...done.provenance, file: done.file ?? done.provenance.file };

    // The same tone picked twice is one patch, not two — see `findTone3000Patch`.
    const existing = findTone3000Patch(this.patches, provenance);
    if (existing) {
      void this.reuseTone3000Patch(existing, provenance, done);
      return;
    }

    this.createTone3000Patch(provenance, done);
  }

  /** The patch this side writes for a tone the user does not already have. */
  private createTone3000Patch(
    provenance: Tone3000Provenance,
    done: { runId: string; state?: string; moduleId?: string },
  ): void {
    const id = uid('patch');
    const path = patchPath(id);
    if (!path) return;

    const mod = done.moduleId ? this.rack.find((m) => m.id === done.moduleId) : undefined;
    const base = mod
      ? storedFromModule(mod, provenance.title)
      : { name: provenance.title, pluginName: NAM_PLUGIN_NAME, knobs: [] };

    const doc: StoredPatch = {
      // From the module when there is one, so the patch keeps the layout the
      // user was already looking at. An unmapped module — or no module at all —
      // falls back to the shipped pack's mapping below, because a tone that
      // arrives with no knobs is not playable without a detour through
      // parameter mapping, and nothing about downloading a tone says the user
      // asked for that.
      ...base,
      // The fallback mapping is the user's own template (Settings → TONE3000),
      // which starts as the stock NAM layout. Fresh copies: the patch document
      // owns its knobs and the template may be edited afterwards.
      knobs:
        base.knobs.length > 0
          ? base.knobs
          : this.appSettings.tone3000TemplateKnobs.map((k) => ({ ...k })),
      name: provenance.title,
      // Explicitly none, where `storedFromModule` would have copied the
      // module's: the card it was captured on is very likely playing the
      // *previous* tone, and its title is that tone's, not this one's. A
      // TONE3000 patch is titled by its tone — see `patchTitleOverride`, which
      // is what reads it back and is also what repairs the patches already on
      // disk with an inherited name baked in.
      displayName: undefined,
      state: done.state,
      tone3000: provenance,
    };

    this.patches = [...this.patches, toPatch(id, doc)].sort(byName);
    this.writePatch(path, doc);
    this.emitPatches();
    this.onTone3000Install({ runId: done.runId, stage: 'done', patchId: id });

    // Onto the module the user started from, in place: the tone changes, the
    // knob layout and the player's own gain and EQ do not.
    if (done.moduleId) this.loadPatch(done.moduleId, id);
  }

  /** A tone the user already has, downloaded again.
   *
   * The patch on disk is the one that wins: it carries whatever the user has
   * since made of it — their name for it, their knob layout, their own gain and
   * EQ — and none of that is worth losing to a second click on the same tone.
   * So the document is left exactly as it is when the capture is the one it
   * already names, and only the *take* is written through when the user picked
   * a different model of the tone, since the point of that pick is to play it.
   *
   * A document that will not read is treated as no document at all: the patch
   * is written fresh rather than silently doing nothing, which would leave the
   * user with a download and no way to play it. */
  private async reuseTone3000Patch(
    existing: Patch,
    provenance: Tone3000Provenance,
    done: { runId: string; state?: string; moduleId?: string },
  ): Promise<void> {
    const path = patchPath(existing.id);
    const doc = path ? await this.readPatch(existing.id) : null;
    if (!path || !doc) {
      this.createTone3000Patch(provenance, done);
      return;
    }

    if (existing.tone3000?.modelId !== provenance.modelId) {
      const next: StoredPatch = {
        ...doc,
        state: done.state,
        // The variant list comes off the fresh fetch, so a patch written before
        // that list existed grows one here; the rest of the document — name,
        // knobs, the card's look — is the user's and is carried through.
        tone3000: { ...provenance, models: provenance.models ?? doc.tone3000?.models },
      };
      this.patches = this.patches
        .map((p) => (p.id === existing.id ? toPatch(existing.id, next) : p))
        .sort(byName);
      this.writePatch(path, next);
    }

    this.onTone3000Install({ runId: done.runId, stage: 'done', patchId: existing.id });
    if (done.moduleId) this.loadPatch(done.moduleId, existing.id);
  }

  async tone3000Repair(patchId: string): Promise<boolean> {
    const patch = this.findPatch(patchId);
    if (!patch?.tone3000) return false;

    const doc = await this.readPatch(patchId);
    const res = (await this.request('tone3000Repair', {
      toneId: patch.tone3000.toneId,
      modelId: patch.tone3000.modelId,
      format: patch.tone3000.format,
      state: doc?.state ?? '',
    })) as { ok?: boolean; state?: string };

    if (!res.ok || !res.state || !doc) return false;

    // The engine may have repointed the state at this machine's copy - which is
    // what makes a patch carried over from another computer, or another
    // operating system, playable rather than silent. Persisted, or the repair
    // would have to happen again on every launch.
    const path = patchPath(patchId);
    if (path) this.writePatch(path, { ...doc, state: res.state });
    return true;
  }

  async tone3000Verify(): Promise<Set<string>> {
    const files = referencedFiles(this.patches);
    if (files.length === 0) return new Set();
    const res = (await this.request('tone3000Verify', { files })) as { missing?: string[] };
    return patchesMissingCaptures(this.patches, res.missing ?? []);
  }

  async savePatch(moduleId: string, name: string): Promise<string | null> {
    // A preview must never be captured: "current" is the module's own mapping,
    // not the patch the pointer happened to be trying on when the save was
    // clicked. Settled before the module is read — this is what once let a
    // hover over the menu write another patch's knob layout into this one.
    this.settlePreview(moduleId);
    const mod = this.rack.find((m) => m.id === moduleId);
    const id = uid('patch');
    const path = patchPath(id);
    if (!mod || !path) return null;
    // Awaited before the id goes back: the id is what makes the patch
    // selectable, and returning early would let it be loaded before it has a
    // tone. Only the round-trip is awaited — the write is not.
    const tone = await this.captureModuleState(moduleId);
    // The module's provenance rides along: a patch saved off a module playing
    // a TONE3000 tone is still that capture, so it keeps the tone's identity,
    // its attribution, and the file a repair would go looking for —
    // storedFromModule knows nothing about it, exactly as with the category.
    const doc: StoredPatch = { ...storedFromModule(mod, name), tone3000: mod.tone3000, ...tone };
    this.patches = [...this.patches, toPatch(id, doc)].sort(byName);
    this.writePatch(path, doc);
    this.retitleModule(moduleId, doc.name);
    return id;
  }

  async updatePatch(patchId: string, moduleId: string): Promise<void> {
    // Same rule as savePatch: the recapture reads the module, so a preview
    // still applied would overwrite this patch with another patch's mapping.
    this.settlePreview(moduleId);
    const mod = this.rack.find((m) => m.id === moduleId);
    // A pack patch lives in the shared root, not the user's list, and is
    // writable only where this machine carries the sources it was built from
    // — a Debug build run out of the repo, which is what authoring one is.
    // Everywhere else `devSource` is unset and this refuses, rather than
    // quietly saving the pack's document somewhere else.
    const shipped = this.shippedPatches.find((p) => p.id === patchId);
    if (shipped && !shipped.devSource) return;
    const root = shipped ? ('shared' as const) : undefined;
    const existing = shipped ?? this.patches.find((p) => p.id === patchId);
    const path = patchPath(patchId, root);
    if (!mod || !existing || !path) return;
    const tone = await this.captureModuleState(moduleId);
    // A failed capture keeps the tone already on disk rather than blanking it:
    // the mapping half is still an honest update, and silently dropping the
    // sound would be a worse answer than keeping the previous one. That is the
    // one path that has to read the file back — the tone is not held in memory.
    const previous = tone ? null : await this.readPatch(patchId, root);
    // Recapture the live mapping but keep the patch's identity: same id (so
    // whoever has it loaded stays pointed at it), same name, and the drawer
    // heading the user filed it under — storedFromModule knows nothing of the
    // category, so rebuilding the doc would silently drop it.
    const doc: StoredPatch = {
      ...storedFromModule(mod, existing.name),
      category: existing.category,
      // Carried forward for the same reason as the category, and it matters
      // more: recapturing a TONE3000 patch must not strip the tone's identity,
      // its attribution, or the file a repair would go looking for.
      tone3000: existing.tone3000,
      ...(tone ?? { pluginVersion: previous?.pluginVersion, state: previous?.state }),
    };
    const next = toPatch(patchId, doc, !!shipped, !!shipped);
    if (shipped)
      this.shippedPatches = this.shippedPatches.map((p) => (p.id === patchId ? next : p));
    else this.patches = this.patches.map((p) => (p.id === patchId ? next : p));
    this.writePatch(path, doc, root);
    this.retitleModule(moduleId, doc.name);
  }

  /** A save names the module: the card, the drawer tile and the patch menu
      must all say the saved name the moment the save lands, and the card is
      the one of the three the save does not rewrite by itself. Loading the
      patch back would retitle the card anyway (its stored displayName is its
      name — see storedFromModule), so this only brings that forward. Guarded
      on the module still existing: the capture round-trip was awaited, and
      metaFor would resurrect a deleted module's meta. */
  private retitleModule(moduleId: string, title: string): void {
    if (!this.rack.some((m) => m.id === moduleId)) return;
    const m = this.metaFor(moduleId);
    if (m.displayName === title) return;
    m.displayName = title;
    this.afterMetaChange(moduleId, false);
  }

  loadPatch(moduleId: string, patchId: string): void {
    // A click lands on the row the pointer was previewing, so the preview is
    // the choice: drop the snapshot rather than leave something a later cancel
    // — the menu closing behind the click — could undo.
    if (this.patchPreview?.moduleId === moduleId) this.patchPreview = null;
    const patch = this.applyPatchLook(moduleId, patchId);
    if (patch) void this.applyPatchTone(moduleId, patch);
  }

  /** The half of a patch TS owns — mapping, look and provenance — applied to a
      module. Returns the patch, so the caller can go on to its tone; a preview
      stops here, which is the whole of what makes it free to undo. */
  private applyPatchLook(moduleId: string, patchId: string): Patch | undefined {
    const patch = this.findPatch(patchId);
    if (!patch) return undefined;
    const m = this.metaFor(moduleId);
    // The card's look travels with the mapping, so a patch restores the module
    // it was saved from. Assigned only when the patch carries one: a patch
    // written before this, or a pack's mapping-only one, leaves the card as it
    // is rather than blanking a name and colour the user chose. A TONE3000
    // patch always names the card, since the tone is the card's identity.
    const title = patchTitleOverride(patch);
    if (title !== undefined) m.displayName = title;
    if (patch.color !== undefined) m.color = patch.color;
    if (patch.styleVariant !== undefined) m.styleVariant = patch.styleVariant;
    if (patch.icon !== undefined) m.icon = patch.icon;
    if (patch.texture !== undefined) m.texture = patch.texture;
    // Assigned unconditionally, unlike the look above: this says which tone the
    // module is playing *now*, so loading an ordinary patch over a TONE3000 one
    // has to clear it. A stale credit is worse than none.
    m.tone3000 = patch.tone3000;
    // Replaces the whole knob array, which also drops any MIDI bindings the
    // old knobs carried. Intentional: a patch carries the mapping and the
    // plugin's own tone, but controller wiring belongs to the rig.
    m.knobs = normalizePositions(
      patch.knobs.map((k) => ({
        knobId: uid('knob'),
        paramIndex: k.paramIndex,
        label: k.label,
        isMeter: k.isMeter,
        meterBipolar: k.meterBipolar,
        pos: k.pos,
      })),
    );
    // Mapping first, tone second, and in that order on the wire — which is why
    // the caller sends the tone rather than this: it reaches emitWatch(), so
    // the first poll after the state lands already covers the patch's
    // parameters. The other way round, the new knobs would render a tick stale.
    this.afterMetaChange(moduleId, true);
    return patch;
  }

  previewPatch(moduleId: string, patchId: string): void {
    // A run belongs to one module: stepping over to another module's menu puts
    // this one back before the next is touched, so two modules can never be
    // left holding an unresolved preview between them.
    if (this.patchPreview && this.patchPreview.moduleId !== moduleId) this.restorePreview();
    if (!this.patchPreview) {
      if (!this.rack.some((m) => m.id === moduleId)) return;
      // Cloned knob by knob: restoring must not hand back an array the
      // preview's own load has since replaced.
      const meta = this.metaFor(moduleId);
      this.patchPreview = {
        moduleId,
        meta: { ...meta, knobs: meta.knobs.map((k) => ({ ...k })) },
      };
    }
    this.applyPatchLook(moduleId, patchId);
  }

  cancelPatchPreview(moduleId: string): void {
    if (this.patchPreview?.moduleId !== moduleId) return;
    this.restorePreview();
  }

  /** End any preview running on `moduleId` by putting the module back as it
      was. Every capture path (savePatch, updatePatch) calls this before
      reading the module: what is captured must be the module's own state,
      never the try-on. A preview on some other module is left alone — it is
      not what is being read. */
  private settlePreview(moduleId: string): void {
    if (this.patchPreview?.moduleId === moduleId) this.restorePreview();
  }

  /** Put the previewed module's own mapping and look back, and end the run. */
  private restorePreview(): void {
    const run = this.patchPreview;
    this.patchPreview = null;
    if (!run) return;
    this.meta.set(run.moduleId, run.meta);
    this.afterMetaChange(run.moduleId, true);
  }

  // The mutating paths all work off `this.patches`, so a shipped patch can
  // never be renamed, updated or deleted — its id simply is not in there. The
  // early return makes that explicit and, for delete, keeps a pointless write
  // and a deleteFile for a path in the wrong root off the wire.
  renamePatch(patchId: string, name: string): void {
    const clean = name.trim();
    const path = patchPath(patchId);
    if (!clean || !path || !this.isUserPatch(patchId)) return;
    // The card title follows the name, as it does on save: a renamed patch
    // whose stored displayName kept the old name would keep showing it on the
    // drawer tile and stamping it onto every card it is loaded on.
    void this.rewritePatchDoc(patchId, path, { name: clean, displayName: clean });
  }

  setPatchCategory(patchId: string, category: string): void {
    const path = patchPath(patchId);
    if (!path || !this.isUserPatch(patchId)) return;
    // '' clears: undefined leaves no key behind in the written JSON, so the
    // heading goes back to being derived rather than pinned to an empty one.
    void this.rewritePatchDoc(patchId, path, { category: category.trim() || undefined });
  }

  /** Editing a patch's metadata is a read-modify-write: the edited field
      shares a file with the tone, which is not held in memory, so the document
      has to come back off disk to be written around the change. A file that
      will not read leaves both the disk and the list alone, so what the user
      sees still matches what is stored. */
  private async rewritePatchDoc(
    patchId: string,
    path: string,
    change: Pick<Partial<StoredPatch>, 'name' | 'displayName' | 'category'>,
  ): Promise<void> {
    const doc = await this.readPatch(patchId);
    if (!doc) {
      console.error(`Cannot edit ${patchId}: ${path} could not be read`);
      return;
    }
    this.patches = this.patches
      .map((p) => (p.id === patchId ? { ...p, ...change } : p))
      .sort(byName);
    this.writePatch(path, { ...doc, ...change });
  }

  deletePatch(patchId: string): void {
    const path = patchPath(patchId);
    if (!path || !this.isUserPatch(patchId)) return;
    this.patches = this.patches.filter((a) => a.id !== patchId);
    backend()?.emitEvent('deleteFile', { path });
    this.emitPatches();
  }

  private isUserPatch(patchId: string): boolean {
    return this.patches.some((p) => p.id === patchId);
  }

  /** Patches are looked up across both lists everywhere except the mutating
      paths, which deliberately see only the user's own. */
  private findPatch(patchId: string): Patch | undefined {
    return (
      this.patches.find((p) => p.id === patchId) ??
      this.shippedPatches.find((p) => p.id === patchId)
    );
  }

  /** The plugin's own serialised tone for one module, or null when it cannot
      be read — the module is gone, it never had state, or the engine did not
      answer. Callers then store the mapping alone rather than claiming a tone
      the patch does not have. */
  private async captureModuleState(
    moduleId: string,
  ): Promise<Pick<StoredPatch, 'pluginVersion' | 'state'> | null> {
    const mod = this.rack.find((m) => m.id === moduleId);
    if (!mod) return null;
    try {
      const d = await this.request('captureModuleState', { moduleId });
      if (d.ok !== true || typeof d.state !== 'string' || !d.state) return null;
      return {
        pluginVersion: typeof d.pluginVersion === 'string' ? d.pluginVersion : undefined,
        state: d.state,
      };
    } catch (error: unknown) {
      console.error(`Failed to capture the tone of module ${moduleId}`, error);
      return null;
    }
  }

  /** Fire-and-forget: the bridge is ordered, so a later read of this path is
      served after the write has landed. */
  private writePatch(path: string, doc: StoredPatch, root?: 'shared'): void {
    void this.writeFile(path, JSON.stringify(doc, null, 2), root);
    this.emitPatches();
  }

  /** One stored patch, or null if it is missing or will not parse. */
  private async readPatch(id: string, root?: 'shared'): Promise<StoredPatch | null> {
    const path = patchPath(id, root);
    if (!path) return null;
    const { ok, text } = await this.readFile(path, root);
    if (!ok) return null;
    const doc = safeParse<unknown>(text);
    if (!isStoredPatch(doc)) {
      // Not deleted: a corrupt file is still the only copy of that tone, and
      // the user may want to look at it.
      console.error(`${path} is corrupt; ignoring it`);
      return null;
    }
    return doc;
  }

  /** Restore the plugin tone a patch was saved with. Everything here degrades
      to a mapping-only load: a patch whose capture failed, or one a pack
      shipped as a layout alone, simply has no `state` — which is silent. */
  private async applyPatchTone(moduleId: string, patch: Patch): Promise<void> {
    const doc = await this.readPatch(patch.id, patch.readOnly && 'shared');
    if (!doc?.state) return;

    const mod = this.rack.find((m) => m.id === moduleId);
    if (!mod) return;
    if (mod.name !== doc.pluginName) {
      // A blob is only meaningful to the plugin that wrote it; feeding one to
      // a different plugin is at best ignored and at worst a crash.
      console.error(
        `Patch ${patch.name} carries ${doc.pluginName} state, not ${mod.name}; loading the mapping only`,
      );
      return;
    }
    if (doc.pluginVersion && mod.pluginVersion && doc.pluginVersion !== mod.pluginVersion)
      console.warn(
        `Patch ${patch.name} was saved from ${mod.name} ${doc.pluginVersion}, now ${mod.pluginVersion}`,
      );

    // The echo guard identifies staleness by value, so a param the user just
    // dragged could suppress the genuine post-state value for a tick or two.
    // This is not an optimistic write, so the guard has no business here.
    this.pendingParamEcho.delete(moduleId);
    // Started here rather than before the disk read: the window has to cover
    // the plugin's notifications, not the file I/O.
    this.suppressToneDirty(TONE_DIRTY_STATE_GRACE_MS);
    backend()?.emitEvent('applyModuleState', { moduleId, state: doc.state });
    // A second mark after the emit: afterMetaChange already marked the mapping
    // change, but that was before the tone landed, so the autosave it queued
    // could still have captured the pre-state plugin.
    this.markSessionDirty(0);
  }

  subscribePatches(listener: (a: Patch[]) => void): () => void {
    this.patchListeners.add(listener);
    listener(mergePatches(this.patches, this.shippedPatches));
    return () => {
      this.patchListeners.delete(listener);
    };
  }

  /** Rewrite the rig index by applying an operation to what is *on disk*, not
      to the list this page read at boot.

      The per-user data root is shared by construction, so the standalone and
      every plugin instance write this one file. Rewriting a stale snapshot
      silently drops whatever another Plectrify saved since — the entry goes,
      and its `.rig` file is orphaned with nothing left pointing at it. Each
      caller therefore passes the *operation* (append, patch by id, filter by
      id, reorder) rather than a finished list, so a concurrent add survives and
      a delete still deletes. The chain keeps this page's own edits from
      interleaving their read-modify-writes.

      Only the file is reconciled. This page's list takes the operation straight
      away — a save that returns an id the caller may rename in the next breath
      cannot wait on a disk round-trip — and is never written back from the
      merge, which would let a queued edit's older read flicker a just-deleted
      rig back into the list. Picking up another instance's rigs live is a
      different feature; the list is read once, at boot, as it always was. */
  private mutateRigIndex(apply: (entries: RigEntry[]) => RigEntry[]): void {
    this.rigEntries = apply(this.rigEntries);
    this.emitRigs();

    this.rigIndexChain = this.rigIndexChain
      .then(async () => {
        const { ok, text } = await this.readFile(RIG_INDEX);
        const parsed = ok ? safeParse<unknown>(text) : null;
        // No index yet (the first save) or a corrupt one: this page's own list
        // is the best answer there is.
        const merged = isRigEntryArray(parsed) ? apply(parsed) : this.rigEntries;
        await this.writeFile(RIG_INDEX, JSON.stringify(merged, null, 2));
      })
      .catch((error: unknown) => {
        console.error('Failed to update the rig index', error);
      });
  }

  /** The stored half of a rig — everything but its identity, which the caller
      supplies. Null if the rack cannot be captured right now, in which case no
      file may be touched. */
  private async captureRigBody(): Promise<StoredRack | null> {
    // Capturing a rack that is mid-teardown/rebuild would snapshot garbage.
    if (this.busy) return null;
    try {
      // Live clientIds match what captureModules just returned, so the scenes
      // can be stored as-is — they re-key on the next apply.
      return { modules: await this.captureModules(), routing: this.routing, scenes: this.scenes };
    } catch (error: unknown) {
      console.error('Failed to capture the rack for saving', error);
      return null; // leave the rig list and files untouched
    }
  }

  async saveRig(name: string): Promise<string | null> {
    // Snapshot before the capture: drift raised during the disk round-trip
    // was not captured and must stay flagged.
    const toneEpoch = this.toneDirtyEpoch;
    const body = await this.captureRigBody();
    if (!body) return null;
    const clean = name.trim() || nextRigName(this.rigEntries.map((e) => e.name));
    // Always a new rig: a name that another rig already uses is not a match,
    // since the id is the identity. Overwriting one is `updateRig`.
    const id = uid('rig');
    const file = `${RIG_DIR}/${slug(clean)}-${id}.rig`;
    // Only list a rig that actually reached the disk: an index entry pointing at
    // a file that was never written is a rig that fails to load forever after.
    if (!(await this.writeFile(file, JSON.stringify({ id, name: clean, ...body }, null, 2))))
      return null;
    this.clearToneDirty(toneEpoch);
    this.mutateRigIndex((onDisk) => [...onDisk, { id, name: clean, file }]);
    return id;
  }

  async updateRig(rigId: string): Promise<boolean> {
    const entry = this.rigEntries.find((e) => e.id === rigId);
    if (!entry) return false;
    // Snapshot before the capture: drift raised during the disk round-trip
    // was not captured and must stay flagged.
    const toneEpoch = this.toneDirtyEpoch;
    const body = await this.captureRigBody();
    if (!body) return false;
    // Only the rig's file content changes. The index carries id, name and path
    // — none of them move — so it needs no rewrite and the list needs no push.
    const ok = await this.writeFile(
      entry.file,
      JSON.stringify({ id: entry.id, name: entry.name, ...body }, null, 2),
    );
    if (ok) this.clearToneDirty(toneEpoch);
    return ok;
  }

  renameRig(rigId: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    const entry = this.rigEntries.find((e) => e.id === rigId);
    if (!entry) return;
    // The rig's on-disk file keeps its path; only the display name changes, so
    // just rewrite the index. The name inside the .rig file is cosmetic.
    this.mutateRigIndex((onDisk) =>
      onDisk.map((e) => (e.id === rigId ? { ...e, name: clean } : e)),
    );
  }

  async loadRig(rigId: string): Promise<boolean> {
    const entry = this.rigEntries.find((e) => e.id === rigId);
    // Refuse while another whole-rack operation (load, restore, repair) is in
    // flight — two interleaved native applies corrupt the rack.
    if (!entry || this.busy) return false;
    // Latch before the disk read: the async gap between click and apply must
    // not accept a second load or any other edit.
    this.applyingRack = true;
    this.setBusy(true);
    let loaded = false;
    try {
      const { ok, text } = await this.readFile(entry.file);
      const parsed = ok ? safeParse<unknown>(text) : null;
      if (!isStoredRack(parsed)) {
        console.error(`Rig file ${entry.file} is missing or corrupt`);
        return false;
      }
      await this.applyStored(parsed);
      loaded = true;
    } catch (error: unknown) {
      console.error('Failed to apply the rig', error);
    } finally {
      this.applyingRack = false;
      this.setBusy(false);
      // The native timer coalesces plugin-change notifications, so the apply's
      // own echoes can arrive after the latch drops.
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
    // The freshly applied rig is clean by definition; a failed apply stays
    // dirty — a half-applied rack is not the saved rig.
    if (loaded) {
      this.clearToneDirty();
      // Re-apply the remembered scene's values on top of the restored plugin
      // state: state restore is not guaranteed to bring every parameter back
      // (a wah can treat its pedal position as performance state and leave it
      // out of its serialised state). The scene stores exactly those values,
      // and rig saves capture scene drift first, so the active scene matched
      // the live rack when the rig was written — applying it restores what
      // the plugin state left behind, and a loaded rig's scene reads clean.
      if (this.activeSceneId) this.applyScene(this.activeSceneId);
    }
    this.markSessionDirty(0);
    return loaded;
  }

  async newRig(): Promise<void> {
    // Same whole-rack teardown as a rig load, minus the disk read — so it takes
    // the same latch, and is refused while another apply is in flight.
    if (this.busy) return;
    this.applyingRack = true;
    this.setBusy(true);
    try {
      await this.applyStored({ modules: [], routing: { groups: [] } });
      this.clearToneDirty(); // an empty rack has no plugin state to drift
    } catch (error: unknown) {
      console.error('Failed to clear the rack', error);
    } finally {
      this.applyingRack = false;
      this.setBusy(false);
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
    this.markSessionDirty(0);
  }

  deleteRig(rigId: string): void {
    const entry = this.rigEntries.find((e) => e.id === rigId);
    if (!entry) return;
    backend()?.emitEvent('deleteFile', { path: entry.file });
    this.mutateRigIndex((onDisk) => onDisk.filter((e) => e.id !== rigId));
  }

  moveRig(rigId: string, toIndex: number): void {
    const from = this.rigEntries.findIndex((e) => e.id === rigId);
    if (from < 0 || toIndex < 0 || toIndex >= this.rigEntries.length || toIndex === from) return;
    // The index file *is* the order: the .rig files are untouched.
    const entries = [...this.rigEntries];
    entries.splice(toIndex, 0, ...entries.splice(from, 1));
    const order = entries.map((e) => e.id);
    this.mutateRigIndex((onDisk) => {
      // The dragged order, over the entries that still exist — taking the
      // on-disk objects so a concurrent rename is not undone by the drag.
      // Anything this page has never seen keeps its place after them.
      const byId = new Map(onDisk.map((e) => [e.id, e]));
      const dragged = order.map((id) => byId.get(id)).filter((e) => e !== undefined);
      const known = new Set(order);
      return [...dragged, ...onDisk.filter((e) => !known.has(e.id))];
    });
  }

  subscribeRigs(listener: (r: Rig[]) => void): () => void {
    this.rigListeners.add(listener);
    listener(this.rigList());
    return () => {
      this.rigListeners.delete(listener);
    };
  }

  // --- Scenes (lightweight snapshots inside the current rig) ---------------
  // Captured and stored purely TS-side: the live values/nodes/routing already
  // hold everything a scene needs, so no native round-trip is involved.

  saveScene(name: string): void {
    const scene = captureScene(
      name.trim() || `Scene ${this.scenes.length + 1}`,
      this.rack,
      this.routing,
    );
    this.scenes = [...this.scenes, scene];
    this.setActiveScene(scene.id);
    this.emitScenes();
    this.markSessionDirty(0);
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
    this.markSessionDirty(0);
  }

  applyScene(sceneId: string): void {
    // Refuse while a whole-rack apply is in flight, like loadRig — but no
    // latch of our own: a scene apply is a batch of real-time-safe writes,
    // not a teardown.
    if (this.busy) return;
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;

    // Mapped parameter values: optimistic local update (like setParam), then
    // one batched bridge event. Values already at the target are skipped, so
    // an unchanged module costs no host notification at all.
    const live = new Set(this.nodes.map((n) => n.id));
    const paramBatch: Array<{ id: string; params: Array<{ paramIndex: number; value: number }> }> =
      [];
    for (const entry of scene.modules) {
      if (!live.has(entry.moduleId)) continue;
      const changes: Array<{ paramIndex: number; value: number }> = [];
      for (const p of entry.params) {
        const clamped = Math.max(0, Math.min(1, p.value));
        const cur = this.values.get(entry.moduleId)?.get(p.paramIndex);
        if (cur && Math.abs(cur.value - clamped) <= SCENE_VALUE_EPSILON) continue;
        notePendingParamWrite(
          this.pendingParamEcho,
          entry.moduleId,
          p.paramIndex,
          clamped,
          cur?.value,
          performance.now(),
        );
        this.setValue(entry.moduleId, p.paramIndex, {
          value: clamped,
          text: this.textFor(entry.moduleId, p.paramIndex, clamped) ?? cur?.text,
        });
        changes.push({ paramIndex: p.paramIndex, value: clamped });
      }
      if (changes.length > 0) paramBatch.push({ id: entry.moduleId, params: changes });
    }
    if (paramBatch.length > 0) backend()?.emitEvent('setParams', { modules: paramBatch });

    // Lane state before bypass and switch: those two echo full rackChanged
    // snapshots, and C++ builds each snapshot when it processes the event —
    // in bridge order. A lane-mix write queued behind them would be missing
    // from those snapshots, and the echo's wholesale routing replace would
    // revert it with no later echo to correct it (setLaneMix deliberately
    // does not echo). Flushing first also puts a fader drag from the last
    // 30 ms on the wire ahead of the scene's values, and lets the scene's
    // own setLaneMix calls take the immediate-emit path. Only lanes and
    // switches that actually differ are sent.
    this.flushLaneMix();
    const liveLanes = new Map(
      this.routing.groups.flatMap((g) => g.lanes.map((lane) => [lane.id, lane] as const)),
    );
    for (const entry of scene.lanes) {
      const lane = liveLanes.get(entry.laneId);
      if (!lane) continue;
      if (
        Math.abs(lane.gain - entry.gain) <= SCENE_VALUE_EPSILON &&
        Math.abs(lane.pan - entry.pan) <= SCENE_VALUE_EPSILON &&
        lane.muted === entry.muted &&
        lane.soloed === entry.soloed
      )
        continue;
      this.setLaneMix(entry.laneId, {
        gain: entry.gain,
        pan: entry.pan,
        muted: entry.muted,
        soloed: entry.soloed,
      });
    }

    // Bypass: one batched event → one revision bump and one rackChanged echo.
    // Gapless engine-side (per-node flags, no graph rebuild). Applied
    // optimistically to the local nodes (like setParam's values) so a second
    // scene switch before the echo diffs against the intended state, not a
    // stale one — skipping a flip the engine still needs.
    const bypassBatch = scene.modules
      .filter((entry) =>
        this.nodes.some((n) => n.id === entry.moduleId && n.bypassed !== entry.bypassed),
      )
      .map((entry) => ({ id: entry.moduleId, bypassed: entry.bypassed }));
    if (bypassBatch.length > 0) {
      const flips = new Map(bypassBatch.map((e) => [e.id, e.bypassed]));
      this.nodes = this.nodes.map((n) =>
        flips.has(n.id) ? { ...n, bypassed: flips.get(n.id)! } : n,
      );
      backend()?.emitEvent('setBypassStates', { modules: bypassBatch });
    }

    for (const entry of scene.switches) {
      const group = this.routing.groups.find((g) => g.id === entry.groupId);
      if (!group || (group.activeLaneId ?? undefined) === (entry.activeLaneId ?? undefined))
        continue;
      backend()?.emitEvent('setLaneSwitch', {
        groupId: entry.groupId,
        activeLaneId: entry.activeLaneId ?? '',
      });
    }

    this.rebuild();
    this.setActiveScene(sceneId);
    this.emitScenes();
    // The setParams burst above echoes back through the plugin-change
    // listener; a scene apply is not plugin-internal drift.
    this.suppressToneDirty(TONE_DIRTY_SCENE_GRACE_MS);
    // The debounce collapses the engine's value echoes into a single deferred
    // captureRig instead of a capture storm.
    this.markSessionDirty(300);
  }

  renameScene(sceneId: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.scenes = this.scenes.map((s) => (s.id === sceneId ? { ...s, name: clean } : s));
    this.emitScenes();
    this.markSessionDirty(0);
  }

  deleteScene(sceneId: string): void {
    this.scenes = this.scenes.filter((s) => s.id !== sceneId);
    if (this.activeSceneId === sceneId) this.setActiveScene(null);
    this.emitScenes();
    this.markSessionDirty(0);
  }

  moveScene(sceneId: string, toIndex: number): void {
    const from = this.scenes.findIndex((s) => s.id === sceneId);
    if (from < 0 || toIndex < 0 || toIndex >= this.scenes.length || toIndex === from) return;
    const scenes = [...this.scenes];
    scenes.splice(toIndex, 0, ...scenes.splice(from, 1));
    this.scenes = scenes;
    this.emitScenes();
    this.markSessionDirty(0);
  }

  subscribeScenes(listener: (state: SceneState) => void): () => void {
    this.sceneListeners.add(listener);
    listener(this.sceneState());
    return () => {
      this.sceneListeners.delete(listener);
    };
  }

  /** Adopt a scene as active and remember it for the current rig. The map in
      app settings is what brings the selection back after a rig switch or a
      restart — no user save involved. */
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

  /** Keep scenes structurally mirroring the live rack: entries for removed
      modules/knobs/lanes/groups are pruned, new ones are backfilled from live
      state (see `reconcileScenes`). Suppressed while a whole-rack apply is in
      flight — in that window the live rack and the scenes belong to different
      racks — and re-run explicitly (forced) by `applyStored` once the applied
      rack has echoed back. Param backfill waits until the engine has streamed
      a real value; `rebuild()` substitutes placeholders that would otherwise
      dirty every scene when the true value arrives. */
  private reconcileLiveScenes(force = false): void {
    if (!force && this.applyingRack) return;
    if (this.scenes.length === 0) return;
    const { scenes, changed } = reconcileScenes(this.scenes, this.rack, this.routing, {
      hasKnownValue: (moduleId, paramIndex) => this.values.get(moduleId)?.has(paramIndex) ?? false,
    });
    if (!changed) return;
    this.scenes = scenes;
    this.emitScenes();
    this.markSessionDirty(0);
  }

  // --- Parallel routing (split / merge) -----------------------------------
  // These are commands only. C++ validates them and publishes the resulting
  // authoritative topology in the next rackChanged snapshot.

  createSplit(atModuleId: string): void {
    const idx = this.rack.findIndex((m) => m.id === atModuleId);
    if (idx < 0 || this.rack[idx].laneId) return;
    const groupPosition = this.rack.slice(0, idx).filter((m) => !m.laneId).length;
    // Name the lanes as they are minted, so the name is the lane's own from the
    // start rather than something read off its current position.
    const lanes = [makeLane(laneName(0)), makeLane(laneName(1))];
    for (const lane of lanes) this.laneNames.set(lane.id, lane.name);
    this.markSessionDirty();
    // Switch mode from the start, on the lane that inherited the module: the
    // chain sounds exactly as it did before the split. Sent with the split
    // itself rather than as a follow-up setLaneSwitch, so the group is never
    // echoed in mix mode first.
    backend()?.emitEvent('createSplit', {
      groupId: uid('group'),
      atModuleId,
      groupPosition,
      laneIds: lanes.map((lane) => lane.id),
      activeLaneId: lanes[0].id,
    });
  }

  addLane(groupId: string): void {
    const target = this.routing.groups.find((g) => g.id === groupId);
    if (!target) return;
    // Name the lane as it is minted, like createSplit does, so the name is the
    // lane's own from the start rather than read off the unnamed C++ echo.
    const lane = makeLane(nextLaneName(target.lanes));
    this.laneNames.set(lane.id, lane.name);
    this.markSessionDirty();
    backend()?.emitEvent('addLane', { groupId, laneId: lane.id });
  }

  removeLane(laneId: string): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    this.markSessionDirty();
    backend()?.emitEvent('removeLane', { laneId });
  }

  /** Stamp the remembered TS-only lane metadata — name and MIDI trigger —
      onto every echoed lane. A lane first seen here (a rig written before
      names existed, or one C++ kept across a repair) adopts the incoming
      values and keeps them from then on. One dead-lane sweep prunes both
      overlays. */
  private withLaneMeta(routing: RoutingState): RoutingState {
    const live = new Set<string>();
    const groups = routing.groups.map((group) => ({
      ...group,
      lanes: group.lanes.map((lane) => {
        live.add(lane.id);
        const name = this.laneNames.get(lane.id) ?? lane.name;
        this.laneNames.set(lane.id, name);
        const midi = this.laneMidi.get(lane.id) ?? lane.midi;
        if (midi) this.laneMidi.set(lane.id, midi);
        // A mix write parked in the fader throttle is UI truth C++ has not
        // seen yet: this snapshot predates it, and the throttled emit that
        // follows produces no echo of its own. Re-stamp it so the wholesale
        // routing replace cannot revert an in-flight drag.
        const pending = this.laneMixPending.get(lane.id);
        return lane.name === name && lane.midi === midi && !pending
          ? lane
          : { ...lane, name, midi, ...pending };
      }),
    }));
    for (const id of [...this.laneNames.keys()]) if (!live.has(id)) this.laneNames.delete(id);
    for (const id of [...this.laneMidi.keys()]) if (!live.has(id)) this.laneMidi.delete(id);
    return { groups };
  }

  setLaneMidi(laneId: string, trigger: MidiTrigger | null): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    if (trigger) this.laneMidi.set(laneId, trigger);
    else this.laneMidi.delete(laneId);
    // Like a rename: the binding never reaches C++, so publish locally and
    // arm the save here — there is no native echo to do either.
    this.routing = {
      groups: this.routing.groups.map((g) => ({
        ...g,
        lanes: g.lanes.map((l) => (l.id === laneId ? { ...l, midi: trigger ?? undefined } : l)),
      })),
    };
    this.emitRouting();
    this.markSessionDirty(0);
  }

  renameLane(laneId: string, name: string): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    const index = group.lanes.findIndex((l) => l.id === laneId);
    const clean = name.trim() || laneName(index);
    if (this.laneNames.get(laneId) === clean) return;
    // Names never reach C++, so there is no echo to wait for: publish locally.
    this.laneNames.set(laneId, clean);
    this.routing = {
      groups: this.routing.groups.map((g) => ({
        ...g,
        lanes: g.lanes.map((l) => (l.id === laneId ? { ...l, name: clean } : l)),
      })),
    };
    this.emitRouting();
    // Unlike every other mutator, a rename has no native echo to arm the save,
    // so schedule it here (debounced to coalesce typing).
    this.markSessionDirty(300);
  }

  moveLane(laneId: string, toIndex: number): void {
    const group = this.routing.groups.find((g) => g.lanes.some((l) => l.id === laneId));
    if (!group) return;
    const from = group.lanes.findIndex((l) => l.id === laneId);
    if (toIndex < 0 || toIndex >= group.lanes.length || toIndex === from) return;
    this.markSessionDirty();
    backend()?.emitEvent('moveLane', { laneId, toIndex });
  }

  setLaneMix(laneId: string, mix: Partial<Omit<LaneMix, 'id'>>): void {
    const laneExists = this.routing.groups.some((group) =>
      group.lanes.some((lane) => lane.id === laneId),
    );
    if (!laneExists) return;

    const clamped: Partial<Omit<LaneMix, 'id'>> = { ...mix };
    if (clamped.gain !== undefined) clamped.gain = Math.max(0, Math.min(2, clamped.gain));
    if (clamped.pan !== undefined) clamped.pan = Math.max(-1, Math.min(1, clamped.pan));

    this.routing = {
      ...this.routing,
      groups: this.routing.groups.map((group) => ({
        ...group,
        lanes: group.lanes.map((lane) => (lane.id === laneId ? { ...lane, ...clamped } : lane)),
      })),
    };
    this.emitRouting();
    this.markSessionDirty(300);

    if (!this.laneMixTimers.has(laneId)) {
      backend()?.emitEvent('setLaneMix', { laneId, ...clamped });
      this.armLaneMixTimer(laneId);
    } else {
      this.laneMixPending.set(laneId, {
        ...this.laneMixPending.get(laneId),
        ...clamped,
      });
    }
  }

  setLaneSwitch(groupId: string, activeLaneId: string | null): void {
    const group = this.routing.groups.find((candidate) => candidate.id === groupId);
    if (!group || (activeLaneId && !group.lanes.some((lane) => lane.id === activeLaneId))) return;
    this.markSessionDirty();
    backend()?.emitEvent('setLaneSwitch', { groupId, activeLaneId: activeLaneId ?? '' });
  }

  subscribeRouting(listener: (routing: RoutingState) => void): () => void {
    this.routingListeners.add(listener);
    listener(this.routing);
    return () => {
      this.routingListeners.delete(listener);
    };
  }

  subscribeBusy(listener: (state: EngineBusyState) => void): () => void {
    this.busyListeners.add(listener);
    listener(this.busyState());
    return () => this.busyListeners.delete(listener);
  }

  subscribeToneDirty(listener: (dirty: boolean) => void): () => void {
    this.toneDirtyListeners.add(listener);
    listener(this.toneDirty);
    return () => this.toneDirtyListeners.delete(listener);
  }

  private raiseToneDirty(): void {
    this.toneDirtyEpoch++;
    if (this.toneDirty) return;
    this.toneDirty = true;
    for (const listener of this.toneDirtyListeners) listener(true);
  }

  /** Lower the flag; with an epoch, only if no drift was raised since that
      snapshot was taken. */
  private clearToneDirty(ifEpoch?: number): void {
    if (ifEpoch !== undefined && ifEpoch !== this.toneDirtyEpoch) return;
    if (!this.toneDirty) return;
    this.toneDirty = false;
    for (const listener of this.toneDirtyListeners) listener(false);
  }

  private suppressToneDirty(ms: number): void {
    this.suppressToneDirtyUntil = Math.max(this.suppressToneDirtyUntil, performance.now() + ms);
  }

  private emitRouting(): void {
    for (const l of this.routingListeners) l(this.routing);
  }

  /** Put every throttle-pending lane-mix write on the wire now and disarm the
      timers, so the next setLaneMix takes the immediate-emit path. Bridge
      events are processed FIFO, so anything emitted here is guaranteed to be
      in every later echo's snapshot. */
  private flushLaneMix(): void {
    for (const [laneId, timer] of this.laneMixTimers) {
      clearTimeout(timer);
      const pending = this.laneMixPending.get(laneId);
      if (pending) backend()?.emitEvent('setLaneMix', { laneId, ...pending });
    }
    this.laneMixTimers.clear();
    this.laneMixPending.clear();
  }

  private armLaneMixTimer(laneId: string): void {
    this.laneMixTimers.set(
      laneId,
      setTimeout(() => {
        const pending = this.laneMixPending.get(laneId);
        if (!pending) {
          this.laneMixTimers.delete(laneId);
          return;
        }

        this.laneMixPending.delete(laneId);
        backend()?.emitEvent('setLaneMix', { laneId, ...pending });
        this.armLaneMixTimer(laneId);
      }, LANE_MIX_EMIT_INTERVAL_MS),
    );
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.emitBusy();
  }

  private busyState(): EngineBusyState {
    return this.rackLoading ? { isBusy: true, loading: this.rackLoading } : { isBusy: this.busy };
  }

  private emitBusy(): void {
    const state = this.busyState();
    for (const listener of this.busyListeners) listener(state);
  }

  openEditor(id: string): void {
    // Some plugins fire updateHostDisplay merely because their editor opened.
    this.suppressToneDirty(TONE_DIRTY_EDITOR_GRACE_MS);
    backend()?.emitEvent('openEditor', { id });
  }

  scanPlugins(): void {
    backend()?.emitEvent('scanPlugins', {});
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
    backend()?.emitEvent('requestPluginBlacklist', {});
  }

  retryBlacklistedPlugins(paths?: string[]): void {
    // No optimistic clear: the engine answers with the list it actually holds,
    // which is the unchanged one when a running scan refuses the retry.
    backend()?.emitEvent('retryBlacklistedPlugins', { paths: paths ?? [] });
  }

  private emitBlacklistedPlugins(): void {
    for (const listener of this.blacklistListeners) listener(this.blacklistedPlugins);
  }

  subscribeCatalogue(listener: (state: CatalogueState) => void): () => void {
    this.catalogueListeners.add(listener);
    listener(this.catalogue);
    return () => this.catalogueListeners.delete(listener);
  }

  refreshCatalogue(): void {
    backend()?.emitEvent('requestCatalogue', { refresh: true });
  }

  subscribeInstallProgress(listener: (event: InstallProgress) => void): () => void {
    this.installProgressListeners.add(listener);
    return () => this.installProgressListeners.delete(listener);
  }

  subscribeInstallFinished(listener: (result: InstallFinished) => void): () => void {
    this.installFinishedListeners.add(listener);
    return () => this.installFinishedListeners.delete(listener);
  }

  installPackages(ids: string[], bundleId?: string, rescanAll?: boolean): void {
    if (ids.length === 0) return;
    // Not a request(): its timeout is measured in seconds and a download runs
    // for minutes. Progress and completion arrive as their own events, and the
    // authoritative state is re-pushed when the run ends.
    backend()?.emitEvent('installPackages', {
      requestId: uid('sp'),
      ids,
      bundleId: bundleId ?? '',
      rescanAll: rescanAll === true,
    });
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

  /** Install the starter bundle on a first run, without being asked.
      An app whose rack can hold anything and whose drawer holds nothing is not
      a product, so a fresh installation fetches the usual pedals once — and
      only once, whether or not the run succeeds (`starterInstallAttempted` is
      written before the run, not after).

      Waits for the stored settings: they are what say this has been done
      before, and the defaults claim it has not. The catalogue arrives over the
      network or from the verified cache and the settings from one local file
      read, so this await is ordinarily already resolved — it is here to make
      that ordering a fact rather than a race. */
  private async maybeAutoInstallStarter(): Promise<void> {
    if (this.starterChecked) return;
    await this.appSettingsLoaded;
    if (this.starterChecked) return;

    // Re-read rather than trust the boot-time copy: this decision turns on one
    // stored flag, the file is shared with every other Plectrify on the machine,
    // and a second instance started minutes later would otherwise still be
    // holding the settings from before the first one wrote the flag.
    const stored = await this.readFile(SETTINGS_FILE);
    const settings = stored.ok
      ? normalizeAppSettings(safeParse<unknown>(stored.text))
      : this.appSettings;
    if (this.starterChecked) return;

    const decision = decideStarterAutoInstall(this.catalogue, settings);
    if (!decision.markAttempted) return;

    this.starterChecked = true;
    this.setAppSettings({ starterInstallAttempted: true });
    if (decision.install.length === 0) return;

    this.setStarterInstalling(true);
    // …and the run ends with a scan of every VST3 folder, not just the one it
    // wrote to: this machine has never been scanned, so it is also the moment
    // the user's own plugins are found.
    this.installPackages(decision.install, STARTER_BUNDLE_ID, true);
  }

  cancelInstall(): void {
    backend()?.emitEvent('cancelInstall', {});
  }

  uninstallPackages(ids: string[]): void {
    if (ids.length === 0) return;
    backend()?.emitEvent('uninstallPackages', { requestId: uid('sp'), ids });
  }

  private emitCatalogue(): void {
    for (const listener of this.catalogueListeners) listener(this.catalogue);
  }

  subscribeAudioDevices(listener: (state: AudioDevicesState) => void): () => void {
    this.audioDeviceListeners.add(listener);
    listener(this.audioDevices);
    return () => this.audioDeviceListeners.delete(listener);
  }

  refreshAudioDevices(rescan = false): void {
    backend()?.emitEvent('requestAudioDevices', { rescan });
  }

  setAudioDevice(change: AudioDeviceChange): void {
    // Passed through as given, absent fields and all: "leave this alone" is the
    // difference between setting a block size and reopening the device.
    backend()?.emitEvent('setAudioDevice', { ...change });
  }

  watchInputLevels(watching: boolean): void {
    backend()?.emitEvent('watchInputLevels', { watching });
  }

  subscribeInputLevels(listener: (peaks: number[]) => void): () => void {
    this.inputLevelListeners.add(listener);
    return () => this.inputLevelListeners.delete(listener);
  }

  openAudioSettings(): void {
    backend()?.emitEvent('openAudioSettings', {});
  }

  openExternalUrl(url: string): void {
    backend()?.emitEvent('openExternalUrl', { url });
  }

  startWindowResize(edge: WindowResizeEdge): void {
    backend()?.emitEvent('startWindowResize', { edge });
  }

  setEditorSize(width: number, height: number): void {
    backend()?.emitEvent('setEditorSize', { width, height });
  }

  setAppSettings(settings: Partial<AppSettings>): void {
    const cleanupChanged =
      settings.looperSessionAutoCleanup !== undefined ||
      settings.looperSessionAutoCleanupLimit !== undefined;
    this.appSettingsRevision += 1;
    this.appSettings = normalizeAppSettings({ ...this.appSettings, ...settings });
    this.persistAppSettings(settings);
    this.pushStandbyConfig();
    this.pushWindowTheme();
    this.emitAppSettings();
    if (cleanupChanged) this.pruneAndPersistLooperSessions();
  }

  /** Write settings.json by laying the changed keys over what is on disk, in
      call order.

      The file is shared with every other Plectrify on this machine (see
      mutateRigIndex) and this page's copy has been in memory since boot, so
      writing it whole would revert a preference another instance changed since
      — `starterInstallAttempted` included, which is how two fresh pages both
      decide to install the starter bundle. Only the file is reconciled: what
      this page *shows* stays the optimistic value set above, since nothing here
      has ever re-read another instance's settings. */
  private persistAppSettings(changed: Partial<AppSettings>): void {
    this.appSettingsChain = this.appSettingsChain
      .then(async () => {
        const { ok, text } = await this.readFile(SETTINGS_FILE);
        const stored = ok ? safeParse<unknown>(text) : null;
        const merged = normalizeAppSettings({
          ...(stored !== null && typeof stored === 'object' ? stored : {}),
          ...changed,
        });
        await this.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2));
      })
      .catch((error: unknown) => {
        console.error('Failed to write the app settings', error);
      });
  }

  settingsReady(): Promise<void> {
    // The same promise the first-run starter install waits on, for the same
    // reason: until settings.json has answered, the defaults are claiming that
    // nothing has ever happened on this machine.
    return this.appSettingsLoaded;
  }

  /** Mirror the persisted standby preference into the engine, which owns the
      idle clock. Sent on every settings write and once the file has loaded:
      the engine defaults to "off", so it simply stays disabled until this
      arrives — which is the safe way round. */
  private pushStandbyConfig(): void {
    backend()?.emitEvent('setStandby', {
      enabled: this.appSettings.standbyEnabled,
      lightAfterMinutes: this.appSettings.standbyLightAfterMinutes,
      deepAfterMinutes: this.appSettings.standbyDeepAfterMinutes,
      wakeThresholdDb: this.appSettings.standbyWakeThresholdDb,
    });
  }

  /** Mirror the colour theme onto the native window chrome (title bar, window
      controls, border) — the one surface the page's CSS cannot reach. Sent on
      every settings write and once the file has loaded; the host starts dark,
      which is the default, so a light user simply sees it flip at startup. */
  private pushWindowTheme(): void {
    backend()?.emitEvent('setWindowTheme', { theme: this.appSettings.theme });
  }

  standbyCommand(action: 'wake' | 'sleep' | 'activity'): void {
    backend()?.emitEvent('standbyCommand', { action });
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
    this.appInfoListeners.add(listener);
    listener(this.appInfo);
    return () => this.appInfoListeners.delete(listener);
  }

  refreshAppInfo(): void {
    backend()?.emitEvent('requestAppInfo', {});
  }

  private emitAppInfo(): void {
    for (const listener of this.appInfoListeners) listener(this.appInfo);
  }

  subscribeMidiEvents(listener: (events: MidiEvent[]) => void): () => void {
    this.midiEventListeners.add(listener);
    return () => this.midiEventListeners.delete(listener);
  }

  subscribeMidiDevices(listener: (devices: string[]) => void): () => void {
    this.midiDeviceListeners.add(listener);
    listener(this.midiDevices);
    return () => this.midiDeviceListeners.delete(listener);
  }

  refreshMidiDevices(): void {
    backend()?.emitEvent('requestMidiDevices', {});
  }

  looperCommand(action: 'toggle' | 'stop' | 'clear' | 'undo'): void {
    backend()?.emitEvent('looperCommand', { action });
  }

  metronomeCommand(action: 'toggle' | 'sync'): void {
    backend()?.emitEvent('metronomeCommand', { action });
  }

  subscribeLooperSessions(listener: (sessions: LooperSession[]) => void): () => void {
    this.looperSessionListeners.add(listener);
    listener(this.looperSessions);
    return () => this.looperSessionListeners.delete(listener);
  }

  async loadLooperSession(id: string): Promise<boolean> {
    const entry = this.looperSessions.find((s) => s.id === id);
    if (!entry) return false;
    // A loop currently held is archived first through the normal clear path,
    // so loading a session never destroys audio. Armed holds nothing yet, and
    // the engine skips the archive when the held loop is itself an unmodified
    // loaded session — re-clicking rows must not pile up duplicates.
    const state = this.status.looperState;
    if (state !== 'empty' && state !== 'armed') this.looperCommand('clear');
    // The engine replies only once the audio thread has adopted the loop, so
    // `ok` means the session is audibly in place, not merely read.
    const d = await this.request('looperLoadSession', { file: entry.file }).catch(() => ({
      ok: false,
    }));
    return d.ok === true;
  }

  deleteLooperSession(id: string): void {
    const entry = this.looperSessions.find((s) => s.id === id);
    if (!entry) return;
    backend()?.emitEvent('deleteFile', { path: `${LOOPER_SESSION_DIR}/${entry.file}` });
    this.looperSessions = this.looperSessions.filter((s) => s.id !== id);
    this.persistLooperSessions();
  }

  renameLooperSession(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed || !this.looperSessions.some((s) => s.id === id)) return;
    this.looperSessions = this.looperSessions.map((s) =>
      s.id === id ? { ...s, name: trimmed } : s,
    );
    this.persistLooperSessions();
  }

  setLooperSessionKept(id: string, kept: boolean): void {
    if (!this.looperSessions.some((s) => s.id === id)) return;
    this.looperSessions = this.looperSessions.map((s) => (s.id === id ? { ...s, kept } : s));
    // Un-keeping can push the list back over the cap; re-apply it right away
    // rather than waiting for the next save.
    this.pruneAndPersistLooperSessions();
  }

  revealLooperSessions(): void {
    backend()?.emitEvent('revealAppFolder', { dir: LOOPER_SESSION_DIR });
  }

  private onLooperSessionSaved(data: unknown): void {
    const saved = data as { file?: unknown; durationSeconds?: unknown; timestamp?: unknown };
    const file = typeof saved?.file === 'string' ? saved.file : '';
    const durationSeconds = Number(saved?.durationSeconds);
    const createdAt = Number(saved?.timestamp);
    if (!file || !Number.isFinite(durationSeconds) || !Number.isFinite(createdAt)) return;
    this.looperSessions = [
      {
        id: uid('take'),
        name: looperSessionName(createdAt),
        file,
        durationSeconds,
        createdAt,
        kept: false,
      },
      ...this.looperSessions,
    ];
    this.pruneAndPersistLooperSessions();
  }

  private async refreshLooperSessions(): Promise<void> {
    const { ok, text } = await this.readFile(LOOPER_SESSION_INDEX);
    const indexed = ok ? normalizeLooperSessions(safeParse<unknown>(text)) : [];
    // Reconcile against the directory: an entry whose WAV vanished (deleted in
    // Explorer) can never load again, so drop it. Orphan WAVs stay untouched —
    // the user put them there or the index write failed; either way they are
    // visible in the folder, just not in the list.
    const names = new Set(await this.listFiles(LOOPER_SESSION_DIR));
    // A save that landed while this read was in flight has already prepended
    // itself; keep it and append the disk-backed remainder.
    const fresh = this.looperSessions.filter((s) => !indexed.some((e) => e.id === s.id));
    this.looperSessions = [...fresh, ...indexed.filter((s) => names.has(s.file))];
    this.pruneAndPersistLooperSessions();
  }

  private pruneAndPersistLooperSessions(): void {
    const { keep, drop } = pruneLooperSessions(
      this.looperSessions,
      this.appSettings.looperSessionAutoCleanup
        ? this.appSettings.looperSessionAutoCleanupLimit
        : Infinity,
    );
    for (const s of drop)
      backend()?.emitEvent('deleteFile', { path: `${LOOPER_SESSION_DIR}/${s.file}` });
    this.looperSessions = keep;
    this.persistLooperSessions();
  }

  private persistLooperSessions(): void {
    void this.writeFile(LOOPER_SESSION_INDEX, JSON.stringify(this.looperSessions, null, 2));
    this.emitLooperSessions();
  }

  private emitLooperSessions(): void {
    for (const listener of this.looperSessionListeners) listener(this.looperSessions);
  }

  setStatus(status: Partial<SettableStatus>): void {
    this.status = { ...this.status, ...status };
    this.emitStatus();
    backend()?.emitEvent('setStatus', status);
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
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Join: audio truth + metadata truth -> RackModule[] -----------------

  /** Rebuilds `this.rack` from the current nodes + metadata + values. */
  private rebuild(): void {
    this.rack = this.nodes.map((n) => {
      const meta = this.meta.get(n.id) ?? { knobs: [] };
      const vals = this.values.get(n.id);
      const params: MappedParam[] = normalizePositions(meta.knobs).map((k) => {
        const ap = n.availableParams.find((p) => p.index === k.paramIndex);
        const isBoolean = ap?.isBoolean ?? false;
        const v = vals?.get(k.paramIndex);
        return {
          knobId: k.knobId,
          paramIndex: k.paramIndex,
          label: k.label,
          value: v?.value ?? (isBoolean ? 0 : 0.5),
          text: v?.text,
          valueStrings: ap?.valueStrings,
          isBoolean,
          isMeter: k.isMeter,
          meterBipolar: k.meterBipolar,
          pos: k.pos,
          midi: k.midi,
        };
      });
      return {
        id: n.id,
        name: n.name,
        pluginVersion: n.pluginVersion,
        pluginManufacturer: n.pluginManufacturer,
        displayName: meta.displayName,
        color: meta.color,
        styleVariant: meta.styleVariant,
        icon: meta.icon,
        texture: meta.texture,
        tone3000: meta.tone3000,
        bypassed: n.bypassed,
        missing: n.missing,
        params,
        availableParams: n.availableParams,
        laneId: n.laneId,
        midi: meta.midi,
      };
    });
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.rack);
  }

  /** Duplicate client IDs make module actions ambiguous and violate Svelte's
      keyed-list contract. Empty IDs are invalid for the same reason. */
  private hasInvalidNodeIds(): boolean {
    const seen = new Set<string>();
    for (const node of this.nodes) {
      if (!node.id || seen.has(node.id)) return true;
      seen.add(node.id);
    }
    return false;
  }

  /** Captures the live plugins and reapplies them with fresh client IDs. Plugin
      state is preserved while an already-corrupt session is repaired at its
      source instead of merely hiding duplicate keys in the component tree. */
  private async repairInvalidNodeIds(): Promise<void> {
    // Skipping while busy is safe: applies re-mint unique ids, so a corrupt
    // rack can only pre-date the operation currently holding the latch.
    if (this.repairingDuplicateNodeIds || this.busy) return;
    this.repairingDuplicateNodeIds = true;
    // Latch like any other whole-rack apply so user edits and session
    // captures cannot interleave with the repair.
    this.applyingRack = true;
    this.setBusy(true);
    try {
      // Captured modules carry the live clientIds, so the live scenes re-key
      // cleanly through the apply's remint.
      await this.applyStored({
        modules: await this.captureModules(),
        routing: this.routing,
        scenes: this.scenes,
      });
    } catch (error: unknown) {
      console.error('Failed to repair duplicate module ids', error);
    } finally {
      this.applyingRack = false;
      this.setBusy(false);
      this.repairingDuplicateNodeIds = false;
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
  }

  /** Metadata for a module; created empty if the module is new. */
  private metaFor(moduleId: string): ModuleMeta {
    let m = this.meta.get(moduleId);
    if (!m) {
      m = { knobs: [] };
      this.meta.set(moduleId, m);
    }
    return m;
  }

  private paramRef(moduleId: string, paramIndex: number): ParamRef | undefined {
    return this.nodes
      .find((n) => n.id === moduleId)
      ?.availableParams.find((p) => p.index === paramIndex);
  }

  private setValue(moduleId: string, paramIndex: number, v: ParamValue): void {
    let byIndex = this.values.get(moduleId);
    if (!byIndex) {
      byIndex = new Map();
      this.values.set(moduleId, byIndex);
    }
    byIndex.set(paramIndex, v);
  }

  /** Rebuild + persist after a metadata edit; optionally re-register the set of
      parameters C++ should poll (changes only when the mapping's params do). */
  private afterMetaChange(_moduleId: string, watchChanged: boolean): void {
    this.rebuild();
    // Unconditional: setKnobMeter passes watchChanged=false yet still changes
    // which params a scene tracks (meters are excluded from scenes).
    this.reconcileLiveScenes();
    if (watchChanged) this.emitWatch();
    this.markSessionDirty(0);
  }

  /** Drop metadata + values for modules that no longer exist (removed live, or
      replaced by a rig load). Safe because a rig load sets the new metadata
      before `applyRig`, so those ids are present when the echoed nodes arrive. */
  private pruneMeta(): void {
    const live = new Set(this.nodes.map((n) => n.id));
    for (const id of [...this.meta.keys()]) if (!live.has(id)) this.meta.delete(id);
    for (const id of [...this.values.keys()]) if (!live.has(id)) this.values.delete(id);
  }

  /** Tell C++ which parameters to poll, per module — only the mapped ones. */
  private emitWatch(): void {
    const modules = [...this.meta.entries()].map(([id, m]) => ({
      id,
      paramIndexes: [...new Set(m.knobs.map((k) => k.paramIndex))],
    }));
    backend()?.emitEvent('watchParams', { modules });
  }

  /** C++ re-sends the complete table set on every watch change, so replacing
      the whole cache also drops entries for unmapped params and removed
      modules. No rebuild: tables affect only future optimistic writes. */
  private applyTexts(mods: TextUpdate[]): void {
    this.texts = new Map(
      mods.map((upd) => [upd.id, new Map(upd.params.map((p) => [p.paramIndex, p.texts]))]),
    );
  }

  /** The plugin's formatted string for a normalised value, from the cached
      table — undefined until the table for this param has arrived. */
  private textFor(moduleId: string, paramIndex: number, value: number): string | undefined {
    const table = this.texts.get(moduleId)?.get(paramIndex);
    if (!table || table.length === 0) return undefined;
    return table[Math.round(value * (table.length - 1))];
  }

  private applyValues(mods: ValueUpdate[]): void {
    let changed = false;
    let writableChanged = false;
    const now = performance.now();
    for (const upd of mods) {
      for (const p of upd.params) {
        const cur = this.values.get(upd.id)?.get(p.paramIndex);
        // Before the unchanged-value short circuit: an echo confirming the
        // optimistic write is bit-identical to it whenever the written value
        // was already float32-representable (every scene apply re-writes
        // values that came from earlier echoes), and skipping it here would
        // leave the guard armed against a later legitimate return to the
        // pre-write value.
        if (isStaleEcho(this.pendingParamEcho, upd.id, p.paramIndex, p.value, now)) continue;
        if (cur && cur.value === p.value && cur.text === p.text) continue;
        this.setValue(upd.id, p.paramIndex, { value: p.value, text: p.text });
        changed = true;
        const ref = this.nodes
          .find((node) => node.id === upd.id)
          ?.availableParams.find((item) => item.index === p.paramIndex);
        if (cur && !ref?.isReadOnly) writableChanged = true;
      }
    }
    if (changed) {
      this.rebuild();
      // Deferred backfill: a param whose value was unknown when its knob was
      // mapped joins the scenes now, with the real streamed value.
      this.reconcileLiveScenes();
      if (writableChanged && !this.applyingRack) this.markSessionDirty(400);
    }
  }

  private emitPatches(): void {
    const all = mergePatches(this.patches, this.shippedPatches);
    for (const l of this.patchListeners) l(all);
  }

  private emitPlugins(): void {
    for (const l of this.pluginListeners) l(this.plugins);
  }

  /** Apply any pending patch to modules that have just appeared in the
      node list — the deferred half of `addModule(pluginId, patchId)`. */
  private applyPendingPatches(): void {
    if (this.pendingPatch.size === 0) return;
    const live = new Set(this.nodes.map((n) => n.id));
    const toneToApply: Array<[string, Patch]> = [];
    for (const [clientId, patchId] of [...this.pendingPatch]) {
      if (!live.has(clientId)) continue;
      this.pendingPatch.delete(clientId);
      // Across both lists, like every other read: adding a module with a pack's
      // patch is as ordinary as adding one with your own.
      const patch = this.findPatch(patchId);
      if (!patch) continue;
      toneToApply.push([clientId, patch]);
      // Same look-travels-with-the-mapping rule as loadPatch: adding a module
      // with a patch must land the card it was saved from, name and colour
      // included. The module is brand new, so there is nothing of the user's
      // to preserve — which is also why a patch with no title override still
      // names the card: the drawer tile showed the patch's name, and the drop
      // must produce the module the tile promised. (loadPatch stays
      // leave-alone: there an absent override protects the user's rename.)
      this.meta.set(clientId, {
        displayName: patchTitleOverride(patch) ?? patch.name,
        color: patch.color,
        styleVariant: patch.styleVariant,
        icon: patch.icon,
        texture: patch.texture,
        tone3000: patch.tone3000,
        knobs: normalizePositions(
          patch.knobs.map((k) => ({
            knobId: uid('knob'),
            paramIndex: k.paramIndex,
            label: k.label,
            isMeter: k.isMeter,
            meterBipolar: k.meterBipolar,
            pos: k.pos,
          })),
        ),
      });
    }
    // Watch set first, then the tone — same ordering as loadPatch, so the
    // first poll after a blob lands already covers the patch's parameters.
    // The module is in the node list, so its plugin is live and can take it.
    this.emitWatch();
    for (const [clientId, patch] of toneToApply) void this.applyPatchTone(clientId, patch);
  }

  /** Patches from every pack installed under the shared root. Read at startup
      and again after an install, alongside `refreshPatches`.

      Failures here are silent by design: no pack installed is the normal case,
      and it must look exactly like a pack that could not be read — neither is
      a reason to bother someone who is playing. */
  private async refreshShippedPatches(): Promise<void> {
    this.shippedPatches = await this.readPatchDir('shared');
    this.emitPatches();
  }

  private async refreshPatches(): Promise<void> {
    await this.migrateLegacyPatches();
    this.patches = await this.readPatchDir();
    this.emitPatches();
  }

  /** Every patch in a root, read from the directory itself — there is no index
      to consult, and nothing to keep in step with one. A patch that will not
      parse is skipped and logged: one bad one must not cost the user the rest.

      The user's own are files in `patches/`; an installed pack's are folders at
      the top of the shared root, each holding its document and its assets. */
  private async readPatchDir(root?: 'shared'): Promise<Patch[]> {
    // Which of them the engine will accept a write for. Empty in a shipped
    // build (nothing there has sources), so this is the whole gate: the page
    // never asks what configuration it is running in.
    const listing =
      root === 'shared'
        ? await this.listing('', 'dirs', root, 'writable')
        : { names: patchIdsFrom(await this.listFiles(PATCH_DIR)), writable: [] };
    const ids = root === 'shared' ? sharedPatchIdsFrom(listing.names) : listing.names;
    const writable = new Set(listing.writable);
    const docs = await Promise.all(ids.map((id) => this.readPatch(id, root)));
    return docs
      .flatMap((doc, i) =>
        doc ? [toPatch(ids[i]!, doc, root === 'shared', writable.has(ids[i]!))] : [],
      )
      .sort(byName);
  }

  /** Bring the user's own patches forward from when they were called presets.
      Two older shapes exist, in the order they were written: a `presets.json`
      index carrying the mappings beside tone-only sidecars, and then one whole
      `presets/<id>.preset` per patch with no index at all. Both land as
      `patches/<id>.patch`, ids intact, and the originals go once the new file
      is safely down.

      Runs before the directory is read, so a migrated patch is simply there.
      Anything that fails is left where it is and retried on the next launch —
      the alternative is a patch the user saved being neither in the old place
      nor the new one. */
  private async migrateLegacyPatches(): Promise<void> {
    const unclaimed = new Set(legacyPatchIdsFrom(await this.listFiles(LEGACY_PATCH_DIR)));
    const index = await this.readFile(LEGACY_INDEX_FILE);
    const entries = index.ok ? safeParse<unknown>(index.text) : null;
    if (index.ok && !Array.isArray(entries)) {
      console.error(`${LEGACY_INDEX_FILE} is corrupt; leaving it in place`);
      return;
    }
    if (!index.ok && unclaimed.size === 0) return;

    // The oldest shape. Neither half is a patch on its own — the index holds the
    // name, plugin and mapping, the sidecar beside it holds the tone — so they
    // are joined here and written out as the one file a patch is now.
    const migratedIndexSources: string[] = [];
    for (const entry of (entries ?? []) as Array<Partial<Patch>>) {
      const from = typeof entry?.id === 'string' ? legacyPatchPath(entry.id) : null;
      if (!from) continue;
      if (
        typeof entry.name !== 'string' ||
        !entry.name.trim() ||
        typeof entry.pluginName !== 'string' ||
        !entry.pluginName.trim()
      ) {
        console.error(`${from} has invalid index metadata; leaving the legacy migration in place`);
        return;
      }
      const doc: StoredPatch = {
        name: entry.name,
        pluginName: entry.pluginName,
        knobs: Array.isArray(entry.knobs) ? entry.knobs : [],
        ...(await this.readLegacyTone(from)),
      };
      if (!(await this.migrateOnePatch(entry.id!, from, doc, false))) return; // retry next launch
      migratedIndexSources.push(from);
      unclaimed.delete(entry.id!);
    }

    // Keep every tone sidecar until all indexed destinations are durable. If a
    // later write fails, the next launch can retry every row with both halves
    // still present instead of rebuilding an earlier one without its tone.
    for (const from of migratedIndexSources) backend()?.emitEvent('deleteFile', { path: from });

    // Whatever the index did not claim, which means two different things. With
    // an index present these are patches deleted while the app was closed, which
    // the old build pruned against it on startup; with no index at all every one
    // of them is a whole patch of the newer shape.
    for (const id of unclaimed) {
      const from = legacyPatchPath(id)!;
      if (index.ok) {
        backend()?.emitEvent('deleteFile', { path: from });
        continue;
      }
      const { ok, text } = await this.readFile(from);
      const doc = ok ? safeParse<unknown>(text) : null;
      if (!isStoredPatch(doc)) {
        console.error(`${from} is not a patch; leaving it in place`);
        continue;
      }
      if (!(await this.migrateOnePatch(id, from, doc))) return; // retry next launch
    }

    if (index.ok) backend()?.emitEvent('deleteFile', { path: LEGACY_INDEX_FILE });
  }

  /** Write one migrated patch, then drop what it came from — in that order, so
      an interruption leaves the original to be found again next launch rather
      than leaving nothing at all. */
  private async migrateOnePatch(
    id: string,
    from: string,
    doc: StoredPatch,
    deleteSource = true,
  ): Promise<boolean> {
    const to = patchPath(id);
    if (!to) return false;

    // A prior indexed attempt may have durably written this patch, deleted its
    // tone sidecar, then failed on a later row while leaving the index for a
    // retry. Keep that completed destination: rebuilding it now would replace
    // its tone with the mapping-only document the missing sidecar produces.
    const existing = await this.readFile(to);
    if (!existing.ok || !isStoredPatch(safeParse<unknown>(existing.text))) {
      if (!(await this.writeFile(to, JSON.stringify(doc, null, 2)))) return false;
    }

    if (deleteSource) backend()?.emitEvent('deleteFile', { path: from });
    return true;
  }

  /** The tone half of a pre-index-removal sidecar, which carried `presetId`,
      `pluginName`, `pluginVersion` and `state` and no mapping at all. */
  private async readLegacyTone(
    path: string,
  ): Promise<Pick<StoredPatch, 'pluginVersion' | 'state'>> {
    const { ok, text } = await this.readFile(path);
    const doc = ok ? safeParse<{ pluginVersion?: unknown; state?: unknown }>(text) : null;
    return {
      pluginVersion: typeof doc?.pluginVersion === 'string' ? doc.pluginVersion : undefined,
      state: typeof doc?.state === 'string' && doc.state ? doc.state : undefined,
    };
  }

  private rigList(): Rig[] {
    return this.rigEntries.map(({ id, name }) => ({ id, name }));
  }

  private emitRigs(): void {
    const list = this.rigList();
    for (const l of this.rigListeners) l(list);
  }

  // --- Request/response over the broadcast-only bridge --------------------
  private request(
    emitId: string,
    payload: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const b = backend();
    // uid() is unique across WebView reloads: a stale reply from before a
    // reload must never resolve a new request (worst case, with the wrong
    // file's content).
    const requestId = uid('q');
    return new Promise((resolve, reject) => {
      if (!b) {
        resolve({});
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.fileReadChunks.delete(requestId); // drop a half-assembled chunked read
        reject(new Error(`Engine did not answer '${emitId}' within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, (d) => {
        clearTimeout(timer);
        resolve(d as Record<string, unknown>);
      });
      b.emitEvent(emitId, { ...payload, requestId });
    });
  }

  private resolvePending(data: unknown): void {
    const d = data as { requestId?: string };
    if (!d?.requestId) return;
    const resolve = this.pending.get(d.requestId);
    if (resolve) {
      this.pending.delete(d.requestId);
      resolve(data);
    }
  }

  private resolveFileReadChunk(data: unknown): void {
    const chunk = data as {
      requestId?: string;
      index?: number;
      total?: number;
      text?: string;
      done?: boolean;
      ok?: boolean;
      encoding?: string;
    };
    if (!chunk.requestId) return;

    if (!chunk.done) {
      const parts = this.fileReadChunks.get(chunk.requestId) ?? [];
      parts[Math.max(0, Number(chunk.index) || 0)] = chunk.text ?? '';
      this.fileReadChunks.set(chunk.requestId, parts);
      return;
    }

    const parts = this.fileReadChunks.get(chunk.requestId) ?? [];
    this.fileReadChunks.delete(chunk.requestId);
    const encoded = parts.join('');
    if (chunk.encoding === 'gzip-base64') {
      void this.decompressFileRead(chunk.requestId, encoded, Boolean(chunk.ok));
      return;
    }
    this.resolvePending({ requestId: chunk.requestId, ok: Boolean(chunk.ok), text: encoded });
  }

  private async decompressFileRead(requestId: string, encoded: string, ok: boolean): Promise<void> {
    try {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      this.resolvePending({ requestId, ok, text });
    } catch (error: unknown) {
      console.error('Failed to decompress native file response', error);
      this.resolvePending({ requestId, ok: false, text: '' });
    }
  }

  /** Capture each live plugin's tone blob from C++ and merge it with the
      TS-owned metadata into the on-disk module shape. */
  private async captureModules(): Promise<StoredModule[]> {
    const capturedMeta = new Map(
      [...this.meta.entries()].map(([id, meta]) => [id, structuredClone(meta)]),
    );
    const capturedNodes = [...this.nodes];
    const d = await this.request('captureRig', {});
    const tone =
      (d.rack as Array<{ id: string; description: string; state: string; bypassed: boolean }>) ??
      [];
    return tone.map((t) => {
      const meta = capturedMeta.get(t.id) ?? { knobs: [] };
      return {
        clientId: t.id,
        displayName: meta.displayName,
        color: meta.color,
        styleVariant: meta.styleVariant,
        icon: meta.icon,
        texture: meta.texture,
        midi: meta.midi,
        tone3000: meta.tone3000,
        laneId: capturedNodes.find((n) => n.id === t.id)?.laneId,
        knobs: meta.knobs,
        description: t.description,
        state: t.state,
        bypassed: t.bypassed,
      };
    });
  }

  /** Rebuild the whole chain from a stored rack: seed the metadata (so the
      echoed nodes join correctly), then hand C++ the tone blobs to re-create. */
  private async applyStored(stored: StoredRack): Promise<void> {
    const { modules, routing: storedRouting } = stored;
    // Re-mint every UI identity on apply. Stored clientIds have no references
    // outside their StoredRack, and replacing them heals sessions written by
    // older builds with duplicate ids while preserving mappings, lanes, and
    // tone. Scenes reference the stored clientIds, so record the remint and
    // re-key them through it.
    const nextMeta = new Map<string, ModuleMeta>();
    const idMap = new Map<string, string>();
    const rack = modules.map((m) => {
      const clientId = uid('mod');
      idMap.set(m.clientId, clientId);
      // Sanitize triggers on the way in: a hand-edited rig file must not be
      // able to plant a malformed binding in the live meta.
      const knobs = m.knobs.map((k) => ({
        ...k,
        knobId: uid('knob'),
        midi: sanitizeTrigger(k.midi),
      }));
      nextMeta.set(clientId, {
        displayName: m.displayName,
        // Appearance ids and the colour pass the same gate as triggers: a
        // hand-edited rig file must not plant an unknown id — or, for the
        // colour, an inline-style payload — in the live meta.
        color: asModuleColor(m.color),
        styleVariant: asStyleVariant(m.styleVariant),
        icon: asModuleIcon(m.icon),
        texture: asModuleTexture(m.texture),
        midi: sanitizeTrigger(m.midi),
        // Same gate as the triggers and appearance ids: a hand-edited rig must
        // not plant a half-built credit — or an image URL — in the live meta.
        tone3000: isTone3000Provenance(m.tone3000) ? m.tone3000 : undefined,
        knobs,
      });
      return {
        clientId,
        description: m.description,
        state: m.state,
        bypassed: m.bypassed,
        laneId: m.laneId,
      };
    });
    const legacyLaneIds = [
      ...new Set(modules.map((m) => m.laneId).filter((id): id is string => !!id)),
    ];
    const routing: RoutingState = storedRouting
      ? normalizeRoutingState(storedRouting)
      : {
          groups:
            legacyLaneIds.length >= 2
              ? [
                  {
                    id: uid('group'),
                    position: 0,
                    lanes: legacyLaneIds.map((id, index) => ({
                      id,
                      name: laneName(index),
                      gain: 1,
                      pan: 0,
                      muted: false,
                      soloed: false,
                    })),
                  },
                ]
              : [],
        };

    // Everything derived from the snapshot is above this line, and every write
    // to live state below it: the snapshot comes off disk and can be
    // hand-edited, so a malformed one must be rejected before the old rack's
    // metadata is gone. Keep new derivations above the boundary.
    this.meta = nextMeta;
    this.values.clear();
    // Writes from before the apply must not drop the new rig's first echoes.
    this.pendingParamEcho.clear();
    this.pendingPatch.clear();
    // Cancel (not flush) the fader throttle: lane ids survive an apply, so a
    // value parked mid-drag would otherwise emit a stale mix into the freshly
    // applied rig after its snapshot values landed.
    for (const timer of this.laneMixTimers.values()) clearTimeout(timer);
    this.laneMixTimers.clear();
    this.laneMixPending.clear();
    this.emitWatch();
    this.scenes = remapSceneIds(stored.scenes ?? [], idMap);
    // The snapshot doesn't carry an active scene; bring back the one last
    // used with the current rig (scene ids are stable across applies).
    this.activeSceneId = this.rememberedScene();
    this.emitScenes();
    // Lane ids survive an apply, so re-seed the TS-only lane metadata from the
    // snapshot: the echo that follows carries none, and would otherwise reset
    // names to letters and drop MIDI triggers. (normalizeRoutingState already
    // sanitized the stored triggers.)
    this.laneNames = new Map(
      routing.groups.flatMap((g) => g.lanes.map((lane) => [lane.id, lane.name] as const)),
    );
    this.laneMidi = new Map(
      routing.groups.flatMap((g) =>
        g.lanes.flatMap((lane) => (lane.midi ? [[lane.id, lane.midi] as const] : [])),
      ),
    );
    const d = await this.request('applyRig', { rack, routing }, APPLY_RIG_TIMEOUT_MS);
    // The native side already alerts the user per failed plugin; log the
    // detail here so a bug report carries it too.
    if (Array.isArray(d.failures) && d.failures.length > 0)
      console.error('Some plugins could not be restored', d.failures);
    // The applied rack has echoed back by now (the final rackChanged precedes
    // the rigApplied reply), so heal the remapped scenes against it: backfill
    // modules a pre-reconciliation snapshot never captured, prune the stale.
    // Forced — the applyingRack latch that muted the echo-driven
    // reconciles is still up here.
    this.reconcileLiveScenes(true);
  }

  /** `root` picks which sandbox the path is resolved against: the user's app
      data by default, or the read-only shared package root for an installed
      patch pack. There is no writable counterpart — `writeFile` and
      `deleteFile` reach the app-data root and nothing else. */
  private readFile(path: string, root?: 'shared'): Promise<{ ok: boolean; text: string }> {
    return this.request('readFile', { path, root }).then(
      (d) => ({ ok: Boolean(d.ok), text: (d.text as string) ?? '' }),
      (error: unknown) => {
        console.error(`Failed to read ${path}`, error);
        return { ok: false, text: '' };
      },
    );
  }

  private listFiles(dir: string, root?: 'shared'): Promise<string[]> {
    return this.listing(dir, 'names', root);
  }

  /** The subdirectories of `dir`. Reported separately by the engine, so a
      caller never has to guess whether a name is a file. */
  private listDirs(dir: string, root?: 'shared'): Promise<string[]> {
    return this.listing(dir, 'dirs', root);
  }

  private listing(dir: string, field: 'names' | 'dirs', root?: 'shared'): Promise<string[]>;
  private listing(
    dir: string,
    field: 'names' | 'dirs',
    root: 'shared' | undefined,
    also: 'writable',
  ): Promise<{ names: string[]; writable: string[] }>;
  private listing(
    dir: string,
    field: 'names' | 'dirs',
    root?: 'shared',
    also?: 'writable',
  ): Promise<string[] | { names: string[]; writable: string[] }> {
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

    return this.request('listFiles', { dir, root }).then(
      (data) =>
        also
          ? { names: strings(data[field]), writable: strings(data[also]) }
          : strings(data[field]),
      (error: unknown) => {
        console.error(`Failed to list ${field} in '${dir}'`, error);
        return also ? { names: [], writable: [] } : [];
      },
    );
  }

  /** Writes through the native bridge. Resolves true only once the engine has
      acknowledged a durable write; a negative acknowledgement, a dropped reply
      and a timeout all resolve false and raise the persistence notice. Anything
      that reports state as "saved" must await this. */
  private async writeFile(path: string, text: string, root?: 'shared'): Promise<boolean> {
    // No backend (browser dev) is not a failure: there is nothing to write to,
    // so `request` resolves {} and the absent `ok` reads as success.
    const ok = await this.request('writeFile', { path, text, root }).then(
      (d) => {
        if (d.ok === false) console.error(`Engine failed to write ${path}`);
        return d.ok !== false;
      },
      (error: unknown) => {
        console.error(`Failed to write ${path}`, error);
        return false;
      },
    );
    // Scoped to the path: a healthy autosave must not clear the notice raised
    // by a rig save that failed.
    if (!ok) this.setPersistenceError(path);
    else if (this.status.persistenceError === path) this.setPersistenceError(null);
    return ok;
  }

  private setPersistenceError(path: string | null): void {
    if (this.status.persistenceError === path) return;
    this.status = { ...this.status, persistenceError: path };
    this.emitStatus();
  }

  private async refreshAppSettings(): Promise<void> {
    const revision = this.appSettingsRevision;
    const { ok, text } = await this.readFile(SETTINGS_FILE);
    if (!ok || revision !== this.appSettingsRevision) return;

    const parsed = safeParse<unknown>(text);
    this.appSettings = normalizeAppSettings(parsed);
    this.pushStandbyConfig();
    this.pushWindowTheme();
    this.emitAppSettings();
  }

  // --- Rig list + persistent working session -----------------------------
  private async refreshRigs(): Promise<void> {
    const { ok, text } = await this.readFile(RIG_INDEX);
    const parsed = ok ? safeParse<unknown>(text) : null;
    if (isRigEntryArray(parsed)) {
      this.rigEntries = parsed;
    } else {
      if (ok) console.error(`${RIG_INDEX} is corrupt; the saved-rig list will start empty`);
      this.rigEntries = [];
    }
    this.emitRigs();
  }

  /** True when the engine is the VST3 build inside a DAW. Only meaningful once
      the first appInfo push has landed (awaitHostKind). */
  private isPluginHost(): boolean {
    return this.appInfo.host === 'plugin';
  }

  /** Blocks until the engine has said which host it is. The baked-in boot
      answer settles it before the wait starts; the bounded ask-and-wait loop
      below survives only for an engine older than that field, where after a
      re-ask the answer defaults to standalone rather than wedging the session
      restore forever. */
  private async awaitHostKind(): Promise<void> {
    if (bootHostKind() !== undefined) return; // seeded into appInfo at construction
    for (let attempt = 0; attempt < 2 && !this.appInfoSeen; attempt++) {
      await Promise.race([
        this.appInfoKnown,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (!this.appInfoSeen) backend()?.emitEvent('requestAppInfo', {});
    }
  }

  /** Adopts a stored session's metadata without touching the live rack. The
      plugin's engine outlives the page, so the rack playing right now IS the
      session — clientIds are kept verbatim (they name the live slots), and
      only the page-owned half is seeded: mappings, names, appearance, scenes,
      lane metadata. Every field passes the same sanitizing gates applyStored
      applies, since the document once rode a DAW project file. */
  private adoptStoredMetadata(stored: StoredRack): void {
    const nextMeta = new Map<string, ModuleMeta>();
    for (const m of stored.modules) {
      nextMeta.set(m.clientId, {
        displayName: m.displayName,
        color: asModuleColor(m.color),
        styleVariant: asStyleVariant(m.styleVariant),
        icon: asModuleIcon(m.icon),
        texture: asModuleTexture(m.texture),
        midi: sanitizeTrigger(m.midi),
        tone3000: isTone3000Provenance(m.tone3000) ? m.tone3000 : undefined,
        knobs: m.knobs.map((k) => ({ ...k, knobId: uid('knob'), midi: sanitizeTrigger(k.midi) })),
      });
    }
    this.meta = nextMeta;
    this.values.clear();
    this.emitWatch();

    // Identity remap: scene ids reference the live clientIds, and remapSceneIds
    // is reused purely for its validation of a document off a project file.
    this.scenes = remapSceneIds(
      stored.scenes ?? [],
      new Map(stored.modules.map((m) => [m.clientId, m.clientId])),
    );
    this.activeSceneId = this.rememberedScene();
    this.emitScenes();

    const routing = stored.routing ? normalizeRoutingState(stored.routing) : { groups: [] };
    this.laneNames = new Map(
      routing.groups.flatMap((g) => g.lanes.map((lane) => [lane.id, lane.name] as const)),
    );
    this.laneMidi = new Map(
      routing.groups.flatMap((g) =>
        g.lanes.flatMap((lane) => (lane.midi ? [[lane.id, lane.midi] as const] : [])),
      ),
    );

    // Re-echo so the adopted metadata joins the live modules on screen.
    backend()?.emitEvent('requestRack', {});
  }

  /** The plugin's session restore: read the engine-held document and adopt its
      metadata. No sentinel, no quarantine — the DAW project owns the state's
      crash story, and nothing here instantiates a plugin. */
  private async restorePluginSession(): Promise<void> {
    try {
      const stored = await this.request('readSession', {});
      if (stored.ok) {
        const parsed = safeParse<unknown>((stored.text as string) ?? '');
        if (isStoredRack(parsed)) this.adoptStoredMetadata(parsed);
      }
    } catch (error: unknown) {
      console.error('Failed to read the plugin session', error);
    } finally {
      this.sessionReady = true;
      this.setBusy(false);
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
  }

  private async finishSessionAdoption(): Promise<void> {
    try {
      const stored = await this.request('readSession', {});
      const parsed = stored.ok ? safeParse<unknown>((stored.text as string) ?? '') : null;
      if (isStoredRack(parsed)) this.adoptStoredMetadata(parsed);
    } catch (error: unknown) {
      console.error('Failed to adopt the reloaded session', error);
    } finally {
      this.applyingRack = false;
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
  }

  private async restorePreviousSession(): Promise<void> {
    await this.appSettingsLoaded;
    // Which host this is decides where the session lives — and the plugin's
    // path is adoption, not application: its rack is already running.
    await this.awaitHostKind();
    if (this.isPluginHost()) {
      await this.restorePluginSession();
      return;
    }
    const names = await this.listFiles('');
    try {
      // The previous launch died while restoring this session (a plugin or
      // driver crash). Quarantine it instead of walking back into the same
      // crash: the session moves aside untouched and the rack starts empty.
      if (names.includes(RESTORE_SENTINEL)) {
        backend()?.emitEvent('deleteFile', { path: RESTORE_SENTINEL });
        const suspectFile = names.includes(WORKING_FILE)
          ? WORKING_FILE
          : names.includes(LEGACY_HISTORY_FILE)
            ? LEGACY_HISTORY_FILE
            : undefined;
        if (suspectFile) {
          const suspect = await this.readFile(suspectFile);
          if (suspect.ok) await this.writeFile(WORKING_QUARANTINE, suspect.text);
          backend()?.emitEvent('deleteFile', { path: suspectFile });
        }
        console.error(
          `The previous launch crashed while restoring the session; it was moved to ${WORKING_QUARANTINE}`,
        );
        return;
      }

      let current: StoredRack | undefined;
      if (names.includes(WORKING_FILE)) {
        const stored = await this.readFile(WORKING_FILE);
        const parsed = stored.ok ? safeParse<unknown>(stored.text) : null;
        if (isStoredRack(parsed)) current = parsed;
      }

      // One-shot migration from builds that kept an undo timeline in
      // working-history.json: adopt its cursor entry. Persist it as the new
      // session file before deleting the old one, so a crash or failed apply
      // mid-restore can never leave the session existing nowhere.
      if (!current && names.includes(LEGACY_HISTORY_FILE)) {
        const legacy = await this.readFile(LEGACY_HISTORY_FILE);
        const doc = legacy.ok
          ? safeParse<{ entries?: unknown[]; cursor?: number }>(legacy.text)
          : null;
        const entry = doc?.entries?.[doc?.cursor ?? -1];
        if (isStoredRack(entry)) {
          current = entry;
          await this.writeFile(WORKING_FILE, JSON.stringify(entry, null, 2));
        }
        // A failed read (e.g. a bridge timeout) keeps the file for the next
        // launch; only a read that actually succeeded removes it.
        if (legacy.ok) backend()?.emitEvent('deleteFile', { path: LEGACY_HISTORY_FILE });
      }

      if (!current && names.includes(SESSION_FILE)) {
        const legacy = await this.readFile(SESSION_FILE);
        const parsed = legacy.ok ? safeParse<unknown>(legacy.text) : null;
        if (isStoredRack(parsed)) current = parsed;
      }

      if (!current) return;
      // The sentinel must be on disk before the first plugin instantiates.
      await this.writeFile(RESTORE_SENTINEL, 'restoring');
      this.applyingRack = true;
      await this.applyStored(current);
      // Persist what native restoration actually accepted; unavailable plugins
      // must not leave an impossible session on disk.
      await this.writeFile(WORKING_FILE, JSON.stringify(await this.captureStoredRack(), null, 2));
      backend()?.emitEvent('deleteFile', { path: RESTORE_SENTINEL });
    } catch (error: unknown) {
      console.error('Failed to restore the previous session', error);
      // A non-fatal failure still finished the attempt: don't leave the
      // sentinel to quarantine a session that never crashed the app.
      backend()?.emitEvent('deleteFile', { path: RESTORE_SENTINEL });
    } finally {
      this.applyingRack = false;
      this.sessionReady = true;
      this.setBusy(false);
      this.suppressToneDirty(TONE_DIRTY_APPLY_GRACE_MS);
    }
    if (this.hasInvalidNodeIds()) void this.repairInvalidNodeIds();
  }

  private markSessionDirty(delay?: number): void {
    if (!this.sessionReady || this.applyingRack) return;
    this.sessionDirty = true;
    if (delay !== undefined) this.scheduleSessionSave(delay);
  }

  private scheduleSessionSave(delay: number): void {
    if (!this.sessionReady || this.applyingRack) return;
    if (this.sessionSaveTimer !== undefined) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = undefined;
      void this.flushSessionSave();
    }, delay);
  }

  private async flushSessionSave(): Promise<void> {
    if (this.sessionSaveTimer !== undefined) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = undefined;
    }
    if (!this.sessionReady || this.applyingRack || !this.sessionDirty) {
      await this.sessionSaveChain;
      return;
    }

    // Cleared up-front so an edit landing *during* the write re-arms it, then
    // re-armed if the write never lands: a dropped autosave is a lost edit, so
    // it has to be retried rather than forgotten.
    this.sessionDirty = false;
    let failed = false;
    this.sessionSaveChain = this.sessionSaveChain
      .then(async () => {
        const session = this.isPluginHost()
          ? this.capturePluginSession()
          : await this.captureStoredRack();
        if (await this.writeWorkingSession(JSON.stringify(session, null, 2))) return;
        failed = true;
        this.sessionDirty = true;
      })
      .catch((error: unknown) => {
        failed = true;
        this.sessionDirty = true;
        console.error('Failed to save the working session', error);
      });
    await this.sessionSaveChain;
    // A retry backs off: a lasting failure (a full disk) would otherwise spin
    // the timer at 0 ms for as long as it lasts.
    if (this.sessionDirty) this.scheduleSessionSave(failed ? SESSION_SAVE_RETRY_MS : 0);
  }

  /** Where the working session lands: working-rack.json in the standalone, the
      engine-held document in the plugin — which rides the DAW project instead
      of a global file two instances would fight over, and survives the page
      dying with every editor close. */
  private async writeWorkingSession(text: string): Promise<boolean> {
    if (!this.isPluginHost()) return this.writeFile(WORKING_FILE, text);

    const ok = await this.request('writeSession', { text }).then(
      (d) => d.ok !== false,
      (error: unknown) => {
        console.error('Failed to write the plugin session', error);
        return false;
      },
    );
    // The same scoped notice writeFile raises, under the session's own name.
    if (!ok) this.setPersistenceError(WORKING_FILE);
    else if (this.status.persistenceError === WORKING_FILE) this.setPersistenceError(null);
    return ok;
  }

  private async captureStoredRack(): Promise<StoredRack> {
    const modules = await this.captureModules();
    return {
      modules,
      routing: structuredClone(this.routing),
      scenes: structuredClone(this.scenes),
    };
  }

  /** The plugin's working session: the page's own metadata and nothing else.

      No `captureRig` round-trip, because every plugin's tone is already in the
      host-saved document's `entries` — the engine puts this blob in the *same*
      document, so capturing it here wrote each NAM capture into the DAW project
      twice, the second copy JSON-escaped inside a string and therefore the
      larger of the two, and dragged megabytes across the bridge on every
      autosave to do it. It was never read back either: the plugin restores
      through adoptStoredMetadata, which takes the names, colours, knob
      mappings, scenes and lanes and rebuilds the rack from `entries`.

      `description` and `state` are written empty only because isStoredRack
      requires the keys — the standalone's working-rack.json, which does need
      the tone, shares this shape. */
  private capturePluginSession(): StoredRack {
    return {
      modules: this.nodes.map((node) => {
        const meta = this.meta.get(node.id) ?? { knobs: [] };
        return {
          clientId: node.id,
          displayName: meta.displayName,
          color: meta.color,
          styleVariant: meta.styleVariant,
          icon: meta.icon,
          texture: meta.texture,
          midi: meta.midi,
          tone3000: meta.tone3000,
          laneId: node.laneId,
          knobs: meta.knobs,
          description: '',
          state: '',
          bypassed: node.bypassed,
        };
      }),
      routing: structuredClone(this.routing),
      scenes: structuredClone(this.scenes),
    };
  }
}
