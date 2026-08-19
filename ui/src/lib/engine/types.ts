import type { Tone3000Provenance } from './tone3000';
import type { ModuleIcon, ModuleStyleVariant, ModuleTexture } from './moduleAppearance';

/** One parameter the hosted plugin exposes — the raw material the user maps
    knobs onto. Mirrors AudioProcessorParameter (index + name). */
export interface ParamRef {
  index: number;
  name: string;

  /** Factory default, normalised to 0..1. Used to reset an interactive knob. */
  defaultValue: number;

  /** Plugin-provided labels for a discrete parameter, in value order. */
  valueStrings?: string[];

  /** True when the plugin parameter is a two-state toggle (or a 2-step discrete
      param); the UI renders a switch instead of a knob. A property of the
      parameter itself, reported by the engine. */
  isBoolean?: boolean;

  /** True when the parameter is a read-only readout (a meter / tuner / level
      output the plugin drives, not an automatable control). Reported by the
      engine from the plugin's automatable flag. Used to default a newly mapped
      knob to a meter display; the user can still override per mapping. */
  isReadOnly?: boolean;
}

/** A user-mapped knob: a hosted plugin parameter surfaced with a friendly
    label. `value` is normalised 0..1, matching AudioProcessorParameter::getValue().
    `knobId` is a stable id for this mapping (two knobs may target the same
    plugin parameter). */
export interface MappedParam {
  knobId: string;
  paramIndex: number;
  label: string;
  value: number;
  /** Human-readable current value, e.g. "6.2 dB" (from getCurrentValueAsText). */
  text?: string;
  /** Plugin-provided labels for a multi-choice parameter. Values snap to these positions. */
  valueStrings?: string[];
  /** True when the plugin parameter is a two-state toggle; render a switch, not a knob. */
  isBoolean?: boolean;
  /** True when the user has marked this mapping as a read-only display (a meter /
      tuner readout) rather than an interactive control. A per-mapping choice, not
      a property of the parameter — the same param can be a knob elsewhere. */
  isMeter?: boolean;
  /** For a meter, render the fill from the centre outward (bipolar) rather than
      from the left edge — for signed readouts like a tuner's ±cents, where 0.5
      normalised is the zero point. Ignored unless `isMeter`. */
  meterBipolar?: boolean;
  /** Column-major cell index on the module's 2-row knob grid. Sparse: a knob
      keeps its cell when siblings change. See `knobLayout.ts`. */
  pos?: number;
  /** Learned MIDI trigger driving this knob's parameter (a CC tracks it
      continuously; for a boolean knob a note/PC press toggles it). Travels
      with rigs, never with patches. Never set on a meter. */
  midi?: MidiTrigger;
}

/** A generic module in the rack, in signal-flow order. A module wraps one
    hosted plugin. It starts with no knobs — the user maps them from
    `availableParams`. */
export interface RackModule {
  id: string;
  /** The hosted plugin's own name — the module's stable identity, used to match
      saved patches. */
  name: string;
  /** The hosted plugin's own version string, as it reports it. Engine-supplied
      and diagnostics-only: which build of a plugin is loaded is exactly what a
      "works here, breaks there" report needs. Absent while a module's plugin is
      unloaded (deep standby). */
  pluginVersion?: string;
  /** The plugin's vendor, as it reports it. Diagnostics-only, same as above. */
  pluginManufacturer?: string;
  /** Optional user-facing override for the module's title. Purely a UI concern;
      falls back to `name` when unset. */
  displayName?: string;
  /** Optional user-chosen accent colour for the module card (any full hex
      string). Purely a UI concern; unset means the default panel look. */
  color?: string;
  /** How strongly the card wears its accent colour. Unset means `subtle`, the
      default look — `subtle` is never stored. UI-only, like `color`. */
  styleVariant?: ModuleStyleVariant;
  /** The TONE3000 tone this module is playing, when it came from one.
      Carried on the module rather than looked up from the patch it was loaded
      from, because the patch can be renamed or deleted and the module is still
      playing that tone — and because the card has to be able to name its
      creator and link to its page without asking anything.

      The mapping it arrives with comes from the user's template (see
      `AppSettings.tone3000TemplateKnobs`); the module can be re-mapped like
      any other afterwards. See ModuleCard. */
  tone3000?: Tone3000Provenance;
  /** Glyph shown beside the module title. UI-only; unset means none. */
  icon?: ModuleIcon;
  /** CSS material laid under the card's tint. UI-only; unset means none. */
  texture?: ModuleTexture;
  bypassed: boolean;
  /** True when the hosted plugin could not be loaded (uninstalled or failing
      to instantiate). The module stays in the chain as a placeholder that
      passes audio straight through — audibly like a bypassed module — and its
      saved plugin state is preserved, so reinstalling the plugin and loading
      the rig again restores it intact. Rendered visibly distinct; its knobs
      and editor are inert while missing. */
  missing?: boolean;
  /** User-mapped knobs. Empty until the user adds some. */
  params: MappedParam[];
  /** Every parameter the plugin exposes, for the mapping picker. */
  availableParams: ParamRef[];
  /** When set, this module lives inside a parallel lane (see `RoutingState`)
      rather than the main serial chain. Unset means the module sits in series.
      Matches a `LaneMix.id`. */
  laneId?: string;
  /** Learned MIDI trigger toggling this module's bypass on every press.
      Travels with rigs. */
  midi?: MidiTrigger;
}

/** Mix settings for one parallel lane at the merge point. `gain` is linear
    (1 = unity); `pan` is -1 (hard left) … 0 (centre) … +1 (hard right). */
export interface LaneMix {
  id: string;
  /** User-facing lane name, minted when the lane is created (A, B, C…) and
      renameable. Stored on the lane rather than derived from its position, so
      it survives reordering. */
  name: string;
  gain: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** Learned MIDI trigger that makes this lane its group's active switch lane
      on every press. TS-only lane metadata: like `name`, it does not survive
      the engine's routing echo on its own and is re-stamped from an overlay
      (see JuceEngine.withLaneMeta). */
  midi?: MidiTrigger;
}

/** One ordered parallel-routing group. Each lane is a mini serial chain and
    the lane mixer sums them before the following serial segment. */
export interface SplitGroup {
  id: string;
  /** Insertion index among modules on the main serial chain. */
  position: number;
  /** When set, the split acts as an exclusive lane switch and only this lane
      reaches the merge. Unset keeps the normal parallel sum behavior. */
  activeLaneId?: string;
  lanes: LaneMix[];
}

/** Sequential split/merge groups; groups may be adjacent. */
export interface RoutingState {
  groups: SplitGroup[];
}

/** One module's contribution to a scene: which parameters (by index) hold
    which normalised values, plus the bypass state. Keyed by the module's live
    clientId; persisted scenes are re-keyed whenever a stored rack is applied
    and clientIds are re-minted. */
export interface SceneModuleState {
  moduleId: string;
  bypassed: boolean;
  params: Array<{ paramIndex: number; value: number }>;
}

/** One lane's mix settings inside a scene. Mirrors `LaneMix` minus the name
    (names are rack metadata, not performance state). */
export interface SceneLaneState {
  laneId: string;
  gain: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
}

/** One split group's exclusive-lane selection inside a scene. `activeLaneId`
    unset means the normal parallel sum. */
export interface SceneSwitchState {
  groupId: string;
  activeLaneId?: string;
}

/** A lightweight, named snapshot of the rig's abstracted performance surface:
    knob-mapped parameter values, module bypass states, and lane state. No
    plugin binary state and no topology — applying a scene is a batch of
    real-time-safe parameter writes, so scenes switch without audio dropouts.
    Scenes belong to the rig they were captured in. */
export interface Scene {
  id: string;
  name: string;
  modules: SceneModuleState[];
  lanes: SceneLaneState[];
  switches: SceneSwitchState[];
}

/** The current rig's scene list plus which scene was applied last. */
export interface SceneState {
  scenes: Scene[];
  activeSceneId: string | null;
}

/** A song in the library. Owns everything about itself — name, what it recalls,
    the stage note — and setlists only point at it by id, so re-mapping a rig or
    fixing a note updates every set the song appears in. An absent rigId or
    sceneId means "leave that alone", never "reset it": a song that says nothing
    about the rig must not silence the sound the player is already on. */
export interface Song {
  id: string;
  name: string;
  /** Rig to load. Held by id, not name — rigs are renameable. */
  rigId?: string;
  /** Scene to apply once the rig has settled. Scene ids are only meaningful
      inside their rig, so this is normally set together with rigId. */
  sceneId?: string;
  /** Free-text stage note: key, tuning, count-in cue. */
  notes?: string;
}

/** A named running order over the song library. Pure references, so building a
    set for a new venue is picking songs already played rather than entering
    them again. Selecting no setlist is a first-class state: next/prev then
    walks the library itself, which is how a player who calls songs
    spontaneously uses this. */
export interface Setlist {
  id: string;
  name: string;
  /** Library song ids, in playing order. A song appears at most once — the
      play cursor is a song id, so a repeat would make "where am I" ambiguous. */
  songIds: string[];
}

/** One knob in a saved patch — just the mapping (which parameter, what
    label), without a live value. A loaded patch's knob *values* come from the
    plugin state it was saved with, not from here. */
export interface KnobDef {
  paramIndex: number;
  label: string;
  /** Whether this mapping was saved as a read-only meter display. See `MappedParam.isMeter`. */
  isMeter?: boolean;
  /** Whether the saved meter renders from the centre (bipolar). See `MappedParam.meterBipolar`. */
  meterBipolar?: boolean;
  /** Grid cell to restore the knob to when the patch is applied. */
  pos?: number;
}

/** A saved, named knob mapping for a specific plugin. The user builds a knob
    layout on a module and saves it as a patch; it can be loaded onto any
    module hosting the same plugin, and loading it restores both the layout and
    the sound. `name` defaults to the plugin name but is editable.

    This is the list entry, not the patch: the plugin's own tone is stored in
    the same file (see `StoredPatch` in patches.ts) but stays on disk until the
    patch is loaded. It is an opaque blob, potentially megabytes, and the UI
    never sees it — exactly as it never sees a `Rig`'s. */
export interface Patch {
  id: string;
  name: string;
  /** The plugin this mapping was built for (param indices are plugin-specific). */
  pluginName: string;
  /** The module card's look this patch was saved from — title override,
      accent colour, style variant, icon and texture, as on `RackModule`.
      Loading applies whichever of these the patch carries; unset means the
      card keeps what it has. */
  displayName?: string;
  color?: string;
  styleVariant?: ModuleStyleVariant;
  icon?: ModuleIcon;
  texture?: ModuleTexture;
  knobs: KnobDef[];
  /** The drawer heading the user filed this patch under — a single heading,
      not a path. Absent means "derive one": an installed pack's patch takes
      its package's category, a user patch takes the category of the package
      its plugin came from, and failing both it lands under "Uncategorised". */
  category?: string;
  /** Where this patch's capture came from, when it came from TONE3000. The
      drawer tile, the module card and the patch dropdown all render it, and a
      missing-capture repair needs it — see `Tone3000Provenance`. */
  tone3000?: Tone3000Provenance;
  /** The order this patch asks for within its drawer heading, ahead of the
      name sort. Only ever authored — a pack numbers the patches it ships so
      they read in the order they were designed to (a chorus before a delay
      before three reverbs) rather than alphabetically. Absent sorts last, so
      every patch the user saved, and every pack that numbers nothing, is
      ordered exactly as before. Initial only: `orderPatchEntries` still lets
      a hand drag override it. */
  order?: number;
  /** Set on patches that came from an installed pack rather than from the user.
      They live under the shared package root, are never written to the user's
      patches directory, and cannot be renamed, updated or deleted — only
      duplicated into the user's own list. Absent on everything the user saved. */
  readOnly?: true;
  /** Set on a pack patch whose *sources* this machine carries — a Debug build
      run out of the repo, where `packaging/content/` holds the folder the pack
      was built from. Such a patch can be re-saved from the app (the write goes
      to those sources, never to the installed copy), which is what authoring
      one looks like. Never set in a shipped build: nothing there has sources
      to write back to. */
  devSource?: true;
}

/** One VST3 plugin the host knows about — the choices the module drawer
    offers. `id` is the engine's stable plugin identifier (an opaque string
    passed back to create an instance); `name` is the display name, also used
    to match saved patches to a plugin. `manufacturer` groups the drawer's
    list; it is whatever the plugin reports, and may be empty. */
export interface PluginInfo {
  id: string;
  name: string;
  manufacturer?: string;
  /** The catalogue package this plugin was installed from, joined natively
      against the install markers under the managed plugin directory. Absent
      for plugins the user installed by any other means — which is most of
      them, so absence carries no meaning beyond "not ours to say". */
  packageId?: string;
}

/** A saved snapshot of the entire signal chain: which plugins, in what order,
    each slot's knob mappings, bypass state, and full plugin state (tone). The
    UI only ever sees the id + name — the chain contents live engine-side (in
    the native engine they include each plugin's binary state, which never
    crosses the bridge). */
export interface Rig {
  id: string;
  name: string;
}

/** Progress while the native host rebuilds a rack one plugin at a time. */
export interface RackLoadingProgress {
  /** One-based plugin index; zero while the host is preparing the rack. */
  current: number;
  total: number;
  pluginName?: string;
}

/** Whether a whole-rack operation (rig load, session restore) is in flight.
    The UI locks the workspace while the engine is busy. */
export interface EngineBusyState {
  isBusy: boolean;
  /** Present while the native engine is applying a saved rack. */
  loading?: RackLoadingProgress;
}

/** Which colour theme the UI paints in. Deliberately explicit rather than
    following the OS: on stage the right choice is set by the room's lighting,
    not by whatever Windows happens to be doing. */
export type ThemeName = 'dark' | 'light';

/** Which tuner readout the status bar draws. The needle shows how far off you
    are as a position; the strobe shows it as motion, drifting at the pitch
    error and freezing dead when in tune — the two share one monophonic reading
    and differ only in how its fine end is displayed. */
export type TunerDisplayMode = 'needle' | 'strobe';

/** A panel hosted by the right-hand tool rail. One id per rail icon; tools
    (looper, metronome and the song list) sit at the rail's top, utility panels
    (info, settings) at its bottom. Lives here rather than in the sidebar
    feature because AppSettings persists the active one. */
export type ToolId = 'looper' | 'metronome' | 'setlist' | 'plugins' | 'info' | 'settings';

/** Which harmonic the strobe's top row watches; the row below always watches four
    times that. Higher resolves finer and drifts faster for the same error, so this
    is the one knob trading sensitivity against how fast the pattern moves. */
export type StrobePrecision = 1 | 2 | 4;

/** How far the needle's scale magnifies its centre. ×1 is the plain linear
    scale; higher values stretch the cents around zero through a log-like
    (asinh) curve, so the few cents that matter while dialling in occupy most
    of the width and the far edges compress. The number is the visual
    magnification at zero: at ×4, one cent near the centre moves the needle
    about four times as far as it would on the linear scale. */
export type NeedlePrecision = 1 | 2 | 4;

/** One raw MIDI message as forwarded by the engine, already filtered to the
    three trigger-capable kinds ('note' is a note-on with velocity > 0; the
    engine never forwards note-offs). */
export interface MidiEvent {
  type: 'cc' | 'pc' | 'note';
  /** MIDI channel, 1..16. */
  channel: number;
  /** Controller / program / note number, 0..127. */
  number: number;
  /** CC value or note velocity, 0..127; always 0 for 'pc'. */
  value: number;
}

/** A learned trigger: the message identity a MIDI binding matches on. The CC
    value / velocity is deliberately not part of the identity — press semantics
    live in the matcher (midi.ts), so a momentary switch's release can't count
    as a second press. */
export interface MidiTrigger {
  type: 'cc' | 'pc' | 'note';
  channel: number;
  number: number;
}

/** Bindable MIDI actions. Rig/scene direct selects are index-based and
    order-derived, exactly like the A–Z / 1–0 keyboard shortcut keys. */
export type MidiActionId =
  | `rig:${number}`
  | 'rigNext'
  | 'rigPrev'
  | `scene:${number}`
  | 'sceneNext'
  | 'scenePrev'
  | 'tunerToggle'
  | 'outputMute'
  | 'looperToggle'
  | 'looperStop'
  | 'looperClear'
  | 'looperUndo'
  | 'looperMaximize'
  | 'metronomeToggle'
  | 'metronomeTapTempo'
  | 'metronomeTempoDown'
  | 'metronomeTempoUp'
  | 'metronomeMaximize'
  | 'songNext'
  | 'songPrev'
  | 'songMaximize';

/** How much setup chrome a performance tool shows around its live controls. */
export type ToolViewMode = 'simple' | 'expert';

/** User preferences for the application itself. These survive restarts but are
    deliberately excluded from saved rigs and the working session. */
export interface AppSettings {
  /** Visual scale applied to the rack workspace (0.5 to 1.5). */
  rackZoom: number;
  /** Visual scale applied to the chrome around the rack — top toolbar, tools
      sidebar, and status bar as one setting (0.7 to 1.5). Separate from
      rackZoom so resizing the controls never moves the modules. */
  uiScale: number;
  /** Whether the rack exposes its global editing controls. Remembered as
      workspace state so the last selected Perform/Edit mode survives restarts,
      but deliberately excluded from saved rigs. */
  editMode: boolean;
  /** Height of the edit-mode module drawer, in CSS pixels before the chrome
      scale. User-dragged via the drawer's resize handle; clamped on load. */
  drawerHeight: number;
  /** Whether the module drawer is collapsed to its grab bar alone. The bar
      stays visible so edit mode keeps its way back in; the stored height is
      untouched, so expanding restores the drawer as it was. */
  drawerCollapsed: boolean;
  /** Key of the drawer accordion section left open (`patches:<path>` or
      `plugins:<maker>`, or 'none' for all closed). At most one section is
      open at a time; an empty or stale key falls back to the first section at
      render time, so a rescan or a renamed category never needs a
      migration. */
  drawerOpenSection: string;
  /** Hand-ordered patch tiles, per drawer section: section key → patch ids in
      display order (a Shift-drag inside the drawer writes it). Patches a
      section holds that are not listed follow the ordered ones in the default
      name sort, so a new patch appears without touching the stored order, and
      ids naming patches since deleted are simply skipped. */
  drawerPatchOrder: Record<string, string[]>;
  /** True once the user has dismissed the empty-rack starter-plugins hint.
      The Packages panel stays available in the rail either way — dismissing
      only stops the suggestion, it does not remove the feature. */
  catalogueHintDismissed: boolean;
  /** True once the first-run starter-bundle install has been *attempted* —
      set when the run is started, not when it succeeds, so a fresh
      installation fetches the starter pedals exactly once and never again.
      A launch that finds no usable catalogue starts no run and sets nothing,
      so it is still owed one; a launch that finds any package already
      installed sets it without installing anything, because that machine is
      not new. See starterBundle.ts for the whole rule. */
  starterInstallAttempted: boolean;
  /** Whether the first-run setup wizard has been through. Set when it is
      finished *and* when it is skipped — a player who waved it away must not
      meet it again on every launch, and Settings keeps a way back to it.

      Read the same way as `starterInstallAttempted`: a stored settings object
      with no such field belongs to a machine that has been played on, so the
      wizard is not owed there either. Only the absence of settings.json
      altogether — where normalization is never reached and the default stands
      — is a first run. */
  setupCompleted: boolean;
  /** Id of the saved rig the working rack was last loaded from or saved as
      (empty when none). Remembered so a restart restores the rig selection
      alongside the restored session. */
  activeRigId: string;
  /** Last active scene per rig id, remembered automatically on every scene
      switch. Deliberately kept out of the rig files: which scene is showing
      is workspace state, not rig content. */
  lastSceneByRig: Record<string, string>;
  /** Colour theme for the whole UI. Mirrored into localStorage by App.svelte so
      index.html's boot script can paint it before the first frame — the engine's
      own copy only lands after an async file read. */
  theme: ThemeName;
  /** Which tuner readout the status bar draws. Defaults to the needle: the
      strobe is opt-in because it trades coarse range for fine resolution, and
      because it is pure motion (see the reduced-motion fallback). */
  tunerDisplay: TunerDisplayMode;
  /** Harmonic the strobe's top row watches. Only meaningful while tunerDisplay
      is 'strobe', but stored unconditionally so switching back and forth keeps
      the choice. */
  tunerStrobePrecision: StrobePrecision;
  /** Centre magnification of the needle's scale. Only meaningful while
      tunerDisplay is 'needle', but stored unconditionally so switching back
      and forth keeps the choice. */
  tunerNeedlePrecision: NeedlePrecision;
  /** Whether Auto Standby reclaims resources after a stretch of input silence.
      Off by default: a live-performance tool must never silence or unload a rig
      unless the user asked it to. */
  standbyEnabled: boolean;
  /** Minutes of silence before stage 1 — every plugin's DSP is suspended, so
      CPU drops to ~0 while waking stays imperceptible. */
  standbyLightAfterMinutes: number;
  /** Minutes of silence before stage 2 — plugin state is captured and the
      instances destroyed, freeing their RAM. Zero disables the stage, and it
      stays separately opt-in because waking costs seconds and re-runs every
      plugin's licence check. */
  standbyDeepAfterMinutes: number;
  /** Input level in dBFS above which playing counts as activity. Measured at
      the same point as the status bar's input meter, so the numbers agree. */
  standbyWakeThresholdDb: number;
  /** Simple keeps the looper focused on recording and recall; Expert reveals
      routing, auto-arm, archive management, and MIDI mapping controls. */
  looperViewMode: ToolViewMode;
  /** Simple keeps the metronome focused on tempo and transport; Expert reveals
      meter, subdivision, volume, accent-pattern, and MIDI mapping controls. */
  metronomeViewMode: ToolViewMode;
  /** Simple keeps the Packages panel to the bundle and the install list;
      Expert reveals the filter box, views and tag chips, the outbound link
      cards, and the licence disclosure. */
  packagesViewMode: ToolViewMode;
  /** Whether the song tool exposes its editing controls. The same Perform/Edit
      split the rack has, kept separate from it: a player editing the rack is
      not necessarily editing the book, and mid-set the song panel must show
      nothing that can rename or delete a song by a stray press. */
  songEditMode: boolean;
  /** Whether the looper archive automatically removes the oldest unkept
      sessions after its rolling limit is reached. */
  looperSessionAutoCleanup: boolean;
  /** Number of unkept looper sessions retained while auto-cleanup is on. */
  looperSessionAutoCleanupLimit: number;
  /** Release version whose update notice the user waved away, empty when none.
      Stored as the *offered* version rather than a plain flag so the dismissal
      expires by itself: a release newer than this one is news again, and once
      this one is installed the value is simply stale and inert. Silences only
      the unbidden notice — the About dialog's manual check ignores it. */
  updateDismissedVersion: string;
  /** Learned MIDI triggers, keyed by MidiActionId. Kept as a plain string
      record so normalization stays simple; the key shape is validated on
      load (see appSettings.midiBindingsMap). */
  midiBindings: Record<string, MidiTrigger>;
  /** The knob mapping a freshly downloaded TONE3000 tone arrives with, when
      no module supplies one. Starts as Neural Amp Modeler's stock six-knob
      layout (see NAM_DEFAULT_KNOBS) and is editable in Settings; each module
      can still be re-mapped individually afterwards. An empty list is a real
      choice — the tone then lands with no knobs mapped. */
  tone3000TemplateKnobs: KnobDef[];
  /** Which tool's panel is open beside the right-hand rail, or null for none.
      The rail's icons stay visible either way. Replaces the pre-rail
      toolsSidebarOpen boolean (migrated on load). */
  activeTool: ToolId | null;
  /** The song library. Setlists are ordered views onto this, so a song's data
      lives here once no matter how many sets it appears in. Workspace state
      like lastSceneByRig, deliberately not part of any rig: one library spans
      every rig by definition. */
  songs: Song[];
  /** Named running orders over `songs`. */
  setlists: Setlist[];
  /** Selected setlist, or '' for "playing from the library" — next/prev then
      walks `songs` in its own order. */
  activeSetlistId: string;
  /** The song the player is on, or '' before the first recall. Persisted
      rather than session-only so a restart between soundcheck and the first
      set resumes where the set left off; cleared by normalization when it
      names a song that no longer exists. */
  activeSongId: string;
}

/** The looper's pedal state, engine-owned and advanced on the audio thread.
    'armed' sits between empty and recording: the take starts on the first
    input above the engine's arm threshold, so the loop head is the player's
    first note. */
export type LooperState = 'empty' | 'armed' | 'recording' | 'playing' | 'overdubbing' | 'stopped';

/** One archived looper take. Clearing the looper saves the loop as a session
    (a WAV under looper-sessions/) instead of discarding it; this is its
    TS-owned index entry. Newest first in the list the UI subscribes to. */
export interface LooperSession {
  id: string;
  /** Display name, defaulting to the capture moment ("Aug 6, 14:32"). */
  name: string;
  /** WAV file name inside the sessions directory (never a path). */
  file: string;
  durationSeconds: number;
  /** Epoch ms at capture. */
  createdAt: number;
  /** Kept sessions are exempt from the archive's size cap: never
      auto-discarded, deletable only by hand. */
  kept: boolean;
}

/** A confidence-scored tuner result. Other fields are absent until a stable
    monophonic pitch has been acquired. */
export type TunerReading =
  | { detected: false }
  | {
      detected: true;
      frequencyHz: number;
      midiNote: number;
      cents: number;
      confidence: number;
    };

/** Live host controls and readouts shown in the persistent status bar. Peaks
    are linear amplitudes; gains are decibels relative to unity. */
export interface StatusState {
  inputGainDb: number;
  outputGainDb: number;
  inputPeak: number;
  outputPeak: number;
  /** Persisted status-bar tuner preference. Manual tuning never mutes output. */
  tunerEnabled: boolean;
  /** Transient MIDI-driven stage tuner. Forces analysis and mutes output. */
  midiTunerActive: boolean;
  /** Persisted safety preference: watch the output for a runaway feedback loop. */
  feedbackGuardEnabled: boolean;
  /** True while the guard is holding the output muted. Latched — the engine
      never clears it, because releasing it on its own would just re-enter the
      loop. Writing `false` is the user saying they have turned something down. */
  feedbackMuted: boolean;
  /** The user's own mute: the status bar's MUTE button and nothing else. A
      separate reason from the guard's latch rather than the same flag written
      by hand — turning the guard off drops that latch, and a rig muted on
      purpose must not come back up because of it. Transient. */
  outputMuted: boolean;
  tunerReading: TunerReading;
  /** Fraction of the audio-callback budget used by the whole chain (0..1, may briefly exceed 1). */
  cpuLoad: number;
  /** Process working-set size in MB; 0 = unknown. */
  processRamMb: number;
  /** Total physical RAM in MB; 0 = unknown. */
  systemRamTotalMb: number;
  /** Audio device sample rate in Hz. */
  sampleRate: number;
  /** Audio device buffer size in samples. */
  bufferSize: number;
  /** Dropouts the driver has counted this session, or -1 where it cannot count
      them. Diagnostics only — a non-zero value is the difference between "the
      rig sounds wrong" and "the rig cannot keep up". */
  audioXRuns: number;
  /** Seconds since the host started. Engine-side truth rather than a page-local
      clock: the UI can reload (dev HMR) without the audio engine restarting. */
  uptimeSeconds: number;
  /** Latency the loaded plugins add on top of the driver's own: the graph's
      longest path to the output, so parallel split lanes contribute their max
      rather than a sum. Bypassed slots still count — the graph keeps them
      latency-compensated. */
  chainLatencySamples: number;
  /** Total round-trip latency: audio device input/output plus active plugin chain.
      A negative value means no audio device is currently open. */
  totalLatencySamples: number;
  /** Which Auto Standby stage the engine is in. Reported as level-triggered
      state on every status push rather than as enter/exit events: the bridge
      can drop a message, and a dropped edge would leave the UI permanently
      wrong with nothing to correct it. */
  standbyStage: StandbyStage;
  /** Seconds of continuous input silence. Drives the countdown — do not run a
      local timer for it, because the page's JS timers are throttled while the
      window is occluded, which is exactly when standby matters. */
  standbyIdleSeconds: number;
  /** True while a guard (an open plugin editor, a running scan, a rig load, a
      modal) holds the countdown off. */
  standbyBlocked: boolean;
  /** The engine's echo of the persisted preference. Lets a settings write that
      the bridge dropped be detected and re-sent. */
  standbyEnabled: boolean;
  standbyLightAfterMinutes: number;
  standbyDeepAfterMinutes: number;
  standbyWakeThresholdDb: number;
  /** Plugins that could not be restored on the last wake from deep standby.
      Reported here rather than as a modal: the user did not ask for anything. */
  standbyWakeFailures: StandbyWakeFailure[];
  /** Path of the most recent file the engine failed to persist, or null while
      writes are healthy. Level-triggered like the standby fields, and owned by
      the TS side: the native engine never sends it, so it survives the partial
      merge of every `statusChanged` push. */
  persistenceError: string | null;
  /** The looper pedal, level-triggered like standby: re-stated on every push
      so a dropped message can never leave the pedal display wrong. */
  looperState: LooperState;
  /** Loop length in seconds; while recording, the elapsed record time. */
  looperLengthSeconds: number;
  /** Playhead 0..1; while recording, the fill fraction of the max loop length.
      Pushed at 15 Hz — interpolate for smooth motion (looperPosition.ts). */
  looperPosition: number;
  /** True once the last overdub can be undone (and re-done). */
  looperHasUndo: boolean;
  /** Undo is a buffer swap, so one press undoes and the next redoes: true
      when the next press brings the overdub back. Drives the button label. */
  looperUndoIsRedo: boolean;
  /** Placement preference, engine-persisted: true = after the whole chain
      (loops the processed tone), false = right after the input (loops dry
      guitar into the rig). */
  looperPostChain: boolean;
  /** Auto-arm preference, engine-persisted. On: the main toggle arms and
      recording starts on the first note. Off: toggle records immediately. */
  looperArmEnabled: boolean;
  /** Arm trigger level in dBFS at the looper's tap point, engine-persisted
      and engine-clamped to [-70, -20]. Lower = more sensitive. */
  looperArmThresholdDb: number;
  /** Transient click state. Deliberately starts false on every app launch. */
  metronomeEnabled: boolean;
  /** Engine-owned tempo and bar settings, persisted with the audio setup. */
  metronomeBpm: number;
  metronomeBeatsPerBar: number;
  /** One means beats only; n adds n-1 evenly spaced clicks between beats. */
  metronomeSubdivision: number;
  /** Per-beat level: 0 off, 2 normal, 3 accent. 1 (soft) is a legacy stored
      value the UI normalizes to 2 (beatPattern.sanitizePattern). */
  metronomeAccents: number[];
  metronomeLevelDb: number;
  /** Current zero-based beat. Pushed at 15 Hz; interpolate with phase for
      smooth animation (metronomeBeat.ts). */
  metronomeBeat: number;
  /** Position 0..1 through the current beat, pushed at 15 Hz. */
  metronomeBeatPhase: number;
}

/** How much of the rig Auto Standby has released. 'light' suspends plugin DSP
    (instant wake); 'deep' has unloaded the plugins entirely; 'waking' is the
    multi-second rebuild back from deep. */
export type StandbyStage = 'active' | 'light' | 'deep' | 'waking';

export interface StandbyWakeFailure {
  name: string;
  error: string;
}

/** Neutral status before the engine reports: unity gains, silent meters,
    tuner enabled. Shared by both engines and the UI's initial state. */
export const DEFAULT_STATUS_STATE: StatusState = {
  inputGainDb: 0,
  outputGainDb: 0,
  inputPeak: 0,
  outputPeak: 0,
  tunerEnabled: true,
  midiTunerActive: false,
  feedbackGuardEnabled: false,
  feedbackMuted: false,
  outputMuted: false,
  tunerReading: { detected: false },
  cpuLoad: 0,
  processRamMb: 0,
  systemRamTotalMb: 0,
  sampleRate: 44100,
  bufferSize: 512,
  audioXRuns: -1,
  uptimeSeconds: 0,
  chainLatencySamples: 0,
  totalLatencySamples: -1,
  standbyStage: 'active',
  standbyIdleSeconds: 0,
  standbyBlocked: false,
  standbyEnabled: false,
  standbyLightAfterMinutes: 10,
  standbyDeepAfterMinutes: 0,
  standbyWakeThresholdDb: -50,
  standbyWakeFailures: [],
  persistenceError: null,
  looperState: 'empty',
  looperLengthSeconds: 0,
  looperPosition: 0,
  looperHasUndo: false,
  looperUndoIsRedo: false,
  looperPostChain: true,
  looperArmEnabled: true,
  looperArmThresholdDb: -40,
  metronomeEnabled: false,
  metronomeBpm: 120,
  metronomeBeatsPerBar: 4,
  metronomeSubdivision: 1,
  metronomeAccents: [3, 2, 2, 2],
  metronomeLevelDb: -12,
  metronomeBeat: 0,
  metronomeBeatPhase: 0,
};

/** Which source this exe was built from. Two builds share a version number, so
    the commit is the only thing that identifies one; `dirty` says the hash alone
    does not, because the tree had uncommitted changes. Stamped at build time
    (see cmake/WriteBuildInfo.cmake), empty where git was unavailable. */
export interface AppBuildInfo {
  /** Short commit hash. */
  commit: string;
  /** Uncommitted tracked changes were present when this exe was built. */
  dirty: boolean;
  /** "YYYY-MM-DD HH:MM UTC". */
  builtAt: string;
  /** Toolchain, e.g. "MSVC 19.44". */
  compiler: string;
  /** Whether ASIO support was compiled in — it needs a licence-gated SDK, and
      its absence is the reason ASIO can be missing from the device list.
      Always false on macOS, where ASIO does not exist (CoreAudio is the native
      low-latency driver) and the diagnostics omit the fact entirely. */
  asio: boolean;
  vst3: boolean;
}

/** The machine the host is running on. Deliberately carries no computer name,
    account name or file path: this block is written to be pasted into a public
    issue, and user-profile paths embed the user's account name on both OSes. */
export interface AppSystemInfo {
  os64Bit: boolean;
  cpuModel: string;
  cpuVendor: string;
  cpuSpeedMhz: number;
  /** Logical processors. */
  cpuCores: number;
  cpuPhysicalCores: number;
  ramTotalMb: number;
  language: string;
  region: string;
  /** Primary display, in physical pixels, plus its OS scale factor. */
  displayWidth?: number;
  displayHeight?: number;
  displayScale?: number;
  displayCount: number;
}

/** One driver family the host can open devices through — ASIO or Windows Audio
    on Windows, CoreAudio on macOS. The lists are what the family offers, not
    what is open; nothing here has to be opened to be named. */
export interface AudioDriverInfo {
  name: string;
  /** True when the family names its inputs and outputs separately, so a rig
      needs one of each (Windows Audio, CoreAudio). False for a family where one
      device is both (ASIO), and the wizard then asks one question instead of
      two. */
  separateInputsAndOutputs: boolean;
  outputDevices: string[];
  inputDevices: string[];
}

/** The audio device the rig is playing through, and everything it could be
    playing through instead. Engine-owned in full: the page never opens a
    device, it names one. */
export interface AudioDevicesState {
  drivers: AudioDriverInfo[];
  /** The open driver family. */
  driver: string;
  outputDevice: string;
  inputDevice: string;
  /** False when nothing could be opened at all — the rig is silent, and the
      device step is the only thing that can fix it. */
  open: boolean;
  sampleRate: number;
  sampleRates: number[];
  bufferSize: number;
  bufferSizes: number[];
  /** The block size the engine would choose for this device by itself (see
      Source/app/AudioSetupRules.h). Reported rather than re-derived on this
      side so the rule the engine applies and the one the wizard marks
      "recommended" cannot drift apart. */
  recommendedBufferSize: number;
  /** Names of the device's *enabled* input channels, in the order the engine
      numbers them — so an index into this list is what `inputChannel` means. */
  inputChannels: string[];
  /** Which of those channels the guitar is on. */
  inputChannel: number;
  /** Input + output latency the driver reports, in samples; -1 when unknown. */
  deviceLatencySamples: number;
}

/** Nothing known yet: no drivers, nothing open. Distinguishable from a real
    push only by `drivers` being empty, which is also true of a machine with no
    audio hardware — both cases leave the wizard with nothing to offer, which is
    the same screen. */
export const EMPTY_AUDIO_DEVICES: AudioDevicesState = {
  drivers: [],
  driver: '',
  outputDevice: '',
  inputDevice: '',
  open: false,
  sampleRate: 0,
  sampleRates: [],
  bufferSize: 0,
  bufferSizes: [],
  recommendedBufferSize: 0,
  inputChannels: [],
  inputChannel: 0,
  deviceLatencySamples: -1,
};

/** A partial change to the open audio device. Per field, `undefined` leaves
    that part alone — the same contract `setStatus` uses, because opening a
    device is slow and restating what is already true would reopen it. */
export interface AudioDeviceChange {
  driver?: string;
  outputDevice?: string;
  inputDevice?: string;
  sampleRate?: number;
  bufferSize?: number;
  /** Index into `AudioDevicesState.inputChannels`. Not a device property at
      all — it is which pin of the open device the rack listens to, so setting
      it alone never reopens anything. */
  inputChannel?: number;
}

/** The open audio device. Rate and buffer are deliberately absent — they stream
    live in `StatusState`, so the report has one source per number. Absent
    entirely when no device is open. */
export interface AppAudioInfo {
  /** Driver family, e.g. "ASIO" or "Windows Audio" on Windows, "CoreAudio" on
      macOS. */
  driverType: string;
  deviceName: string;
  bitDepth: number;
  inputChannels: number;
  outputChannels: number;
  inputLatencySamples: number;
  outputLatencySamples: number;
}

/** How big the plugin library is. Counts only: every blacklist entry is a path
    under the user's home directory. */
export interface AppPluginLibraryInfo {
  known: number;
  blacklisted: number;
}

/** A plugin file the scanner refuses to load. The host blacklists a file when a
    scan was interrupted while loading it — a crashing plugin, but equally the
    app being closed or killed mid-scan — and never retries it on its own, so a
    perfectly good plugin can silently vanish from the plugin list. */
export interface BlacklistedPlugin {
  /** Absolute path to the .vst3 file or bundle; the identity a retry names. */
  path: string;
  /** File name without its extension. The scan never got far enough to learn
      the plugin's own name, so this is all there is to show. */
  name: string;
}

/** Which host-owned facilities exist around the engine. The engine pushes this
    with appInfo so standalone-only surfaces — the setup wizard, the audio
    device settings, window chrome, Auto Standby — can hide themselves where
    the host (a DAW, for the VST3 build) owns those concerns. */
export interface HostCapabilities {
  /** Device picker, setup wizard, Advanced audio… */
  audioDevices: boolean;
  /** The MIDI device list. The event stream itself flows regardless — in a
      plugin the DAW's track MIDI arrives on the same events. */
  midiDevices: boolean;
  /** Resize handles and window-theme mirroring. */
  windowChrome: boolean;
  /** The idle park/wake machinery. */
  autoStandby: boolean;
  /** The loop recorder, its rail panel and its session archive. */
  looper: boolean;
  /** The practice metronome and its rail panel. */
  metronome: boolean;
  /** The acoustic-feedback detector — the slideout above the MUTE pill. The
      pill itself is never gated: a hand mute is a panic control every host
      owes the player. */
  feedbackGuard: boolean;
  /** Backing the data root up to a file and restoring it. Declined by the
      plugin: a DAW session's rack rides its project document, so an archive of
      the *global* rigs and settings is not what that session owns, and a
      restore would replace them under every other instance at once. */
  backup: boolean;
}

/** What absence of the capabilities field means: the standalone, which has it
    all — every engine older than the field was one. */
export const STANDALONE_CAPABILITIES: HostCapabilities = {
  audioDevices: true,
  midiDevices: true,
  windowChrome: true,
  autoStandby: true,
  looper: true,
  metronome: true,
  feedbackGuard: true,
  backup: true,
};

/** Facts about the running host only the engine knows — the About dialog and the
    diagnostics a bug report should carry. Not static for the session: the audio
    device and the plugin counts change, and the engine re-pushes the whole block
    when they do. The nested groups are optional because an older engine (or the
    mock) may not report them; the diagnostics dash out whatever is missing
    rather than inventing a value. */
export interface AppInfo {
  /** Semantic version of the running app (the repo's VERSION file). */
  version: string;
  /** Build configuration — 'Debug', 'Release', or 'Mock' in a plain browser. */
  build: string;
  /** Operating-system description, e.g. "Windows 11" or "macOS 14". */
  os: string;
  /** Stable OS discriminator beside the free-text `os`, for the handful of
      places wording must branch (Explorer vs Finder, WebView2 vs WebKit,
      whether ASIO is even a fact worth stating). Absent on an engine older
      than the field — treat absence as 'windows', the only OS those ran on. */
  platform?: 'windows' | 'macos';
  /** Which binary the engine is: the standalone app or the VST3 plugin inside
      a DAW. Absent means 'standalone' — every engine older than the field. */
  host?: 'standalone' | 'plugin';
  /** Which host-owned facilities exist. Absent means everything (standalone);
      gate with `appInfo.capabilities ?? STANDALONE_CAPABILITIES` so the page
      can never flash a degraded layout before the engine's push lands. */
  capabilities?: HostCapabilities;
  juceVersion: string;
  buildInfo?: AppBuildInfo;
  system?: AppSystemInfo;
  audio?: AppAudioInfo;
  plugins?: AppPluginLibraryInfo;
}

/** Empty rather than invented: the dialog shows a dash until the engine's push
    lands, instead of claiming a version that may not be the one running. */
export const DEFAULT_APP_INFO: AppInfo = {
  version: '',
  build: '',
  os: '',
  juceVersion: '',
};
