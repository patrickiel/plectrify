import type {
  AppInfo,
  AppSettings,
  BlacklistedPlugin,
  EngineBusyState,
  LooperSession,
  MidiEvent,
  MidiTrigger,
  Patch,
  LaneMix,
  PluginInfo,
  Rig,
  RackModule,
  RoutingState,
  SceneState,
  StatusState,
} from './types';
import type { InstallFinished, InstallProgress, CatalogueState } from './catalogue';
import type { Tone3000InstallEvent, Tone3000State } from './tone3000';
import type { ModuleIcon, ModuleStyleVariant, ModuleTexture } from './moduleAppearance';

/** A partial update to a module card's look. Per field, `undefined` leaves the
    current value alone and `null` clears it back to the default — so one call
    can change a single dimension without restating the rest. */
export interface ModuleStyleUpdate {
  color?: string | null;
  styleVariant?: ModuleStyleVariant | null;
  icon?: ModuleIcon | null;
  texture?: ModuleTexture | null;
}

/** Host controls the UI may write. Live/read-only fields stay out so every
    engine implementation rejects accidental writes at compile time. */
export type SettableStatus = Pick<
  StatusState,
  | 'inputGainDb'
  | 'outputGainDb'
  | 'tunerEnabled'
  | 'midiTunerActive'
  | 'feedbackGuardEnabled'
  | 'feedbackMuted'
  | 'outputMuted'
  | 'looperPostChain'
  | 'looperArmEnabled'
  | 'looperArmThresholdDb'
  | 'metronomeBpm'
  | 'metronomeBeatsPerBar'
  | 'metronomeSubdivision'
  | 'metronomeAccents'
  | 'metronomeLevelDb'
>;

/** A signal-path gap where a new module can be inserted. Lane gaps use the
    next module as an anchor; serial gaps use their serial index and, when the
    gap precedes a split at that same index, the split's id. */
export interface ModuleInsertTarget {
  laneId?: string;
  beforeModuleId?: string;
  serialPosition?: number;
  beforeGroupId?: string;
}

/** A destination for moving an existing module: any insert gap, or a brand-new
    lane of a split group. Extends the insert vocabulary rather than reusing it
    verbatim so `insertModule`'s own type never suggests a capability it
    lacks. */
export interface ModuleMoveTarget extends ModuleInsertTarget {
  /** Move the module into a freshly created lane of this split group. When
      set, all other fields are ignored. */
  newLaneForGroupId?: string;
}

/** State reported by a host plugin scan. The UI owns presentation; native
    hosts only report when work starts and how many plugins are available. */
export interface PluginScanState {
  status: 'idle' | 'scanning' | 'complete';
  pluginCount: number;
}

/** A window edge or corner the user can grab to resize the native host
    window from inside the web UI. */
export type WindowResizeEdge =
  'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * The contract between the UI and the audio engine.
 *
 * `MockEngine` implements this in the browser today; the JUCE
 * WebBrowserComponent bridge implements the same interface in the hosted app,
 * so the UI never changes when we move from mock to real audio.
 *
 * Modules are generic — a module is just a hosted plugin. The rig gives it no
 * semantic identity; the user builds one by mapping knobs onto the plugin's
 * parameters.
 */
export interface EngineBridge {
  /** Insert a module hosting the plugin identified by `pluginId` at the
      selected signal-path gap, optionally pre-applying a saved patch's knob
      mapping and plugin state. The UI drives plugin choice through its own
      module drawer, so no native menu is involved.

      Returns the id the new module will carry, or null if the target could not
      be resolved. The module does not exist yet — creation is asynchronous and
      the id is minted here so both sides agree on it before the plugin has
      loaded — so this is a promise about a future `rackChanged`, not a handle
      to something present. Callers use it to have something ready for the
      module when it lands (the rack switches its control editor on, a fresh
      plugin having no knob mapping yet). */
  insertModule(pluginId: string, target: ModuleInsertTarget, patchId?: string): string | null;

  /** Swap the plugin behind an existing module for another, in place: same
      signal-path position, same lane, same split structure. The old module is
      gone — its id, knob mapping, name, colour and MIDI bindings go with it,
      because none of them mean anything against a different plugin's
      parameters — and the replacement arrives exactly as `insertModule` would
      have built it, patch and all.

      One operation rather than a remove followed by an insert: the engine
      creates the replacement first and only then drops the old module, so a
      plugin that fails to load leaves the rack untouched, the rack never
      passes through a state with a hole in it, and a lane holding a single
      module is not collapsed out from under the replacement.

      Returns the replacement's id on the same terms as `insertModule`. */
  replaceModule(moduleId: string, pluginId: string, patchId?: string): string | null;

  /** Subscribe to the list of plugins the host can instantiate (populated by a
      scan). Returns an unsubscribe function. */
  subscribePlugins(listener: (plugins: PluginInfo[]) => void): () => void;
  removeModule(id: string): void;
  reorder(id: string, toIndex: number): void;
  /** Move an existing module to any signal-path gap — before/after any module
      in any serial segment or lane, across split boundaries, or into a
      brand-new lane of a split group. One atomic engine operation (a single
      graph edit). Coordinates are pre-move UI coordinates; the engine adjusts
      for the module's own removal. */
  moveModule(id: string, target: ModuleMoveTarget): void;

  /** Exchange two existing modules' places in the chain: each takes the
      other's position — and, across a split boundary, the other's lane —
      keeping its own id, plugin, tone, knob mapping, name, colour and MIDI
      bindings.

      One atomic engine operation rather than two moves. The pair of positions
      is fixed, so no gap has to be named, nothing is ever detached, and no
      split's position changes: only the two payloads trade places. */
  swapModules(moduleIdA: string, moduleIdB: string): void;
  setBypass(id: string, bypassed: boolean): void;

  /** Set a normalised (0..1) value on the plugin parameter behind a knob. */
  setParam(moduleId: string, paramIndex: number, value: number): void;

  /** Surface a plugin parameter as a new knob (label defaults to its name).
      Pass `pos` to place it in a specific grid cell (column-major). */
  addKnob(moduleId: string, paramIndex: number, pos?: number): void;
  /** Drop a knob from the module's mapping. */
  removeKnob(moduleId: string, knobId: string): void;
  /** Point an existing knob at a different plugin parameter. */
  remapKnob(moduleId: string, knobId: string, paramIndex: number): void;
  /** Move a knob to grid cell `pos` (column-major). Swaps with any knob already
      there; other knobs keep their cells. See `knobLayout.ts`. */
  moveKnob(moduleId: string, knobId: string, pos: number): void;
  /** Rename a knob's user-facing label. An empty name falls back to the
      plugin parameter's own name. */
  renameKnob(moduleId: string, knobId: string, label: string): void;
  /** Toggle a mapping between an interactive control and a read-only meter/tuner
      display. A meter never sends `setParam`; it only reflects the live value.
      Enabling the meter clears any learned MIDI binding — meters never carry
      one (see setKnobMidi), and a binding kept invisibly would re-arm on
      convert-back. */
  setKnobMeter(moduleId: string, knobId: string, isMeter: boolean): void;
  /** Toggle a meter between left-origin (unipolar) and centre-origin (bipolar)
      fill. Only meaningful for a mapping already flagged as a meter. */
  setKnobMeterBipolar(moduleId: string, knobId: string, bipolar: boolean): void;
  /** Bind (or clear with null) the MIDI trigger driving a knob's parameter.
      Meters never carry a binding. Persisted with the rig content; patches
      never carry it. */
  setKnobMidi(moduleId: string, knobId: string, trigger: MidiTrigger | null): void;
  /** Set a module's user-facing display name. Persisted by the engine (survives
      restarts and travels with rigs); an empty name reverts to the plugin name. */
  renameModule(moduleId: string, name: string): void;
  /** Apply a partial update to the module card's look — accent colour, style
      variant, icon, texture (see `ModuleStyleUpdate` for the undefined/null
      semantics). Persisted by the engine and travels with rigs and patches. */
  setModuleStyle(moduleId: string, style: ModuleStyleUpdate): void;
  /** Bind (or clear with null) the MIDI press trigger that toggles this
      module's bypass. Persisted with the rig content. */
  setModuleMidi(moduleId: string, trigger: MidiTrigger | null): void;

  /** Save a module's current knob mapping *and* the plugin's own full state —
      every setting, mapped or not, including non-parameter state such as a
      loaded capture or impulse response — as a new named, reusable patch.
      An empty name falls back to the plugin name. Resolves with the new
      patch's id once the tone has been captured, or null if the module is
      gone; nothing may adopt the patch as active before it resolves, since a
      patch offered early could be loaded before it has a tone. An existing
      name is not a match: identity is the id, so this always creates. */
  savePatch(moduleId: string, name: string): Promise<string | null>;
  /** Recapture a module's live knob mapping and plugin state into an existing
      patch (the "update" action), keeping its id and name. */
  updatePatch(patchId: string, moduleId: string): Promise<void>;
  /** Replace a module's knob mapping with a saved patch's, and restore the
      plugin state it was saved with — so loading a patch is audible. A patch
      whose capture failed, or whose file cannot be read, applies its mapping
      only. */
  loadPatch(moduleId: string, patchId: string): void;
  /** Rename a saved patch. An empty name is ignored. A patch marked
      `readOnly` (one installed from a pack) is not the user's to rename. */
  renamePatch(patchId: string, name: string): void;
  /** File a saved patch under a drawer heading of the user's own choosing,
      or clear it with '' so the heading is derived again (see
      `Patch.category`). A `readOnly` patch is not the user's to refile —
      its pack's category applies. */
  setPatchCategory(patchId: string, category: string): void;
  /** Forget a saved patch. Ignored for a `readOnly` patch — uninstalling its
      pack is what removes it. */
  deletePatch(patchId: string): void;
  /** Subscribe to the saved-patches list: the user's own, then any installed
      from a pack (those carry `readOnly`). Returns an unsubscribe function. */
  subscribePatches(listener: (patches: Patch[]) => void): () => void;

  // --- TONE3000 -----------------------------------------------------------
  // Amp captures and impulse responses from the TONE3000 community, downloaded
  // into ordinary patches. The engine owns the account, the network and the
  // files: nothing here takes a token, a URL or a byte of model data, and a
  // downloaded tone becomes a patch like any other — it appears in the drawer,
  // in this plugin's patch menu, and in a saved rig with no extra machinery.

  /** Subscribe to the TONE3000 session: whether an account is connected, who,
      what this build's key is allowed to do, and what has been downloaded.
      Replays the last known value. Returns an unsubscribe function. */
  subscribeTone3000(listener: (state: Tone3000State) => void): () => void;
  /** Ask the engine to push the session state again — same
      dropped-while-occluded reasoning as `refreshAppInfo`. */
  refreshTone3000(): void;
  /** Open TONE3000 — its own window, showing its own pages, straight to the
      catalogue. There is no in-app browser and no step in between: this is the
      one call that starts everything, and a tone the user picks over there is
      downloaded, turned into a patch and (with `moduleId`) loaded onto that
      module without another round trip.

      The window reopens where it was left — same page, same size, same monitor
      — so calling this twice in a session is not two fresh starts.

      Answers arrive on `subscribeTone3000` and `subscribeTone3000Install`, so a
      user who closes the window without picking anything still leaves the UI in
      a settled state. */
  tone3000Browse(options?: {
    /** The module a picked tone should land on. Omitted, the tone becomes a
        drawer patch built from the plugin's factory state. */
    moduleId?: string;
    /** The installed Neural Amp Modeler to build the state from. */
    pluginId?: string;
    /** "1", "2" or "custom". Omitting it is not "all": TONE3000 then applies
        its legacy A1 + Custom selection and hides every A2 capture. Also what
        decides which model is picked when a tone carries several. */
    architecture?: string;
  }): void;
  /** Forget the connected account and its tokens — and the page the window was
      left on, which belongs to that session. Downloaded models and the patches
      made from them are the user's and are left alone. */
  tone3000Disconnect(): void;
  /** Record that the partnership splash has been shown, so it is shown once
      ever rather than once per session. */
  tone3000SplashSeen(): void;
  /** Switch a module to another of its tone's captures. The engine points the
      plugin's live state at that model's file — so the player's own gain, EQ
      and gate survive — and downloads the capture first if it is not already
      there. Resolves false if it could not be loaded. */
  tone3000SelectModel(moduleId: string, modelId: number): Promise<boolean>;
  /** Abandon a download in flight. The only interruption the page can make to
      a run it did not start. */
  tone3000CancelInstall(): void;
  subscribeTone3000Install(listener: (event: Tone3000InstallEvent) => void): () => void;
  /** Fetch a patch's model again if its file is gone, and repoint the patch at
      this machine's copy. Also what makes a patch shared from another computer
      — or another operating system — playable rather than silent. Resolves
      false if the tone is no longer available. */
  tone3000Repair(patchId: string): Promise<boolean>;
  /** Which patches point at a model file that is not on disk, by patch id. */
  tone3000Verify(): Promise<Set<string>>;

  /** Save the entire current signal chain as a new named, recallable rig —
      plugin order, per-slot knob mappings, bypass state, and full plugin tone.
      An empty name falls back to a default. An existing name is not a match:
      identity is the id, so this always creates a rig. Overwriting one is
      `updateRig`.

      Resolves with the new rig's id once it is durably stored, or null if the
      capture or the write failed. Nothing may present the rack as saved — clear
      an unsaved-changes marker, adopt a baseline — before this resolves. */
  saveRig(name: string): Promise<string | null>;
  /** Overwrite a saved rig's stored chain with the live one, keeping its id,
      name and place in the list. Resolves true once it is durably stored; false
      if the rig is unknown, another whole-rack operation is in flight, or the
      capture or the write failed — with the same rule as `saveRig`, nothing may
      present the rack as saved before this resolves. */
  updateRig(rigId: string): Promise<boolean>;
  /** Rename a saved rig. An empty name is ignored (rigs must stay named).
      Duplicate names are allowed: the name is display metadata only. */
  renameRig(rigId: string, name: string): void;
  /** Replace the whole chain with a saved rig: tears down the current modules
      and rebuilds them from the snapshot. Resolves true once the chain has been
      rebuilt; false if the rig file was unreadable or corrupt, or the apply
      failed — in which case the rack is whatever the failure left behind, and
      the caller must not adopt the rig as active. */
  loadRig(rigId: string): Promise<boolean>;
  /** Start from an empty chain: tears down every module and clears all parallel
      routing, leaving no rig active. May return a promise that resolves once
      the chain is cleared, so a follow-up save captures the empty rack. */
  newRig(): void | Promise<void>;
  /** Forget a saved rig. */
  deleteRig(rigId: string): void;
  /** Move a rig to another slot in the saved-rigs list. Presentational — it
      sets the menu order and, with it, the order of the rig-switch buttons. */
  moveRig(rigId: string, toIndex: number): void;
  /** Subscribe to the saved-rigs list. Returns an unsubscribe function. */
  subscribeRigs(listener: (rigs: Rig[]) => void): () => void;

  // --- Scenes (lightweight snapshots inside the current rig) ---------------

  /** Capture the current mapped parameter values, bypass states, and lane
      state as a new named scene of the current rig; it becomes active. An
      empty name falls back to a default. Scenes never store plugin binary
      state, so applying one is dropout-free. */
  saveScene(name: string): void;
  /** Recapture the live state into an existing scene (the "update" action on
      a drifted scene). */
  updateScene(sceneId: string): void;
  /** Apply a scene in real time — batched parameter/bypass/lane writes, no
      graph rebuild. The scene becomes active. */
  applyScene(sceneId: string): void;
  /** Rename a scene. An empty name is ignored. */
  renameScene(sceneId: string, name: string): void;
  /** Forget a scene. */
  deleteScene(sceneId: string): void;
  /** Move a scene to another slot in the current rig's scene list. Scenes are
      independent snapshots, so this is presentational — it sets the menu order
      and the order of the scene-switch buttons. */
  moveScene(sceneId: string, toIndex: number): void;
  /** Subscribe to the current rig's scene list and active selection. */
  subscribeScenes(listener: (state: SceneState) => void): () => void;

  // --- Parallel routing (split / merge) -----------------------------------

  /** Split the chain into parallel lanes at the given module: the module moves
      into the first lane and a second, empty lane is created alongside it, so
      the signal fans out and sums back together. */
  createSplit(atModuleId: string): void;
  /** Add an empty lane to a split group. Modules go into it afterwards through
      the lane's own insertion points, so creating a lane and filling it stay
      two separate, undoable-in-isolation steps. */
  addLane(groupId: string): void;
  /** Remove a parallel lane and every module in it — deleting a branch, not
      rerouting it back into the serial chain. The split collapses automatically
      if fewer than two lanes would remain, and only the surviving lane's
      modules return to the serial chain. */
  removeLane(laneId: string): void;
  /** Move a lane to another slot within its group. Lanes sum in parallel, so
      this is presentational — but it re-labels them, since A/B/C follow the
      lane's position. The lane keeps its modules, mix and switch selection. */
  moveLane(laneId: string, toIndex: number): void;
  /** Rename a lane. An empty name restores its positional default (A, B, C…). */
  renameLane(laneId: string, name: string): void;
  /** Bind (or clear with null) the MIDI press trigger that makes this lane its
      group's active switch lane. Persisted with the rig content. */
  setLaneMidi(laneId: string, trigger: MidiTrigger | null): void;
  /** Update a lane's merge mix (any subset of gain / pan / muted / soloed). */
  setLaneMix(laneId: string, mix: Partial<Omit<LaneMix, 'id'>>): void;
  /** Enable/select the exclusive switch for a split, or disable it with null. */
  setLaneSwitch(groupId: string, activeLaneId: string | null): void;
  /** Subscribe to the parallel-routing topology. Returns an unsubscribe function. */
  subscribeRouting(listener: (routing: RoutingState) => void): () => void;

  /** Subscribe to the engine's whole-rack busy state (rig loads, session
      restore). The UI locks the workspace while the engine is busy. */
  subscribeBusy(listener: (state: EngineBusyState) => void): () => void;

  /** Subscribe to the plugin-internal drift flag: true when a hosted plugin
      has changed its own state (edits in its native editor, program switches)
      since the rig was last saved or loaded — changes invisible to the rack
      signature but captured by a rig save. Replays the current value. */
  subscribeToneDirty(listener: (dirty: boolean) => void): () => void;

  /** Open the plugin's own native editor window (native engine only). */
  openEditor(id: string): void;

  /** Scan the system for VST3 plugins (native engine only). */
  scanPlugins(): void;
  /** Subscribe to plugin-scan progress so it can be presented inside the web UI. */
  subscribePluginScan(listener: (state: PluginScanState) => void): () => void;

  /** Subscribe to the plugin files the scanner skips (blacklisted because a
      scan was interrupted while loading them). Replays the last known list.
      Returns an unsubscribe function. */
  subscribeBlacklistedPlugins(listener: (entries: BlacklistedPlugin[]) => void): () => void;
  /** Ask the engine to re-push the blacklist — same dropped-while-occluded
      reasoning as refreshAppInfo. */
  refreshBlacklistedPlugins(): void;
  /** Clear `paths` from the blacklist — the whole list when omitted — and
      rescan, so the plugins are retried straight away. Refused (silently, with
      a corrective push of the unchanged list) while a scan is running. */
  retryBlacklistedPlugins(paths?: string[]): void;

  /** Subscribe to the plugin catalogue joined with what is installed.
      Replays the last known state. Returns an unsubscribe function. */
  subscribeCatalogue(listener: (state: CatalogueState) => void): () => void;
  /** Ask the engine to re-resolve the catalogue and push it. Called when the
      Packages panel opens, so a user who has just come online doesn't have to
      restart to see the current list. */
  refreshCatalogue(): void;
  /** Subscribe to per-package install progress. Unlike the request/response
      flows, this is a plain stream: a download runs for minutes, well past the
      request timeout. */
  subscribeInstallProgress(listener: (event: InstallProgress) => void): () => void;
  /** Subscribe to the end of an install run. May be missed if the window was
      occluded when it fired, so treat it as a convenience — the authoritative
      state arrives via subscribeCatalogue. */
  subscribeInstallFinished(listener: (result: InstallFinished) => void): () => void;
  /** Download and install the named plugins, in order. Ids not in the
      catalogue are ignored; a run already in flight is refused.

      Pass `bundleId` when the run came from a bundle's own button: the engine then
      records which edition of that bundle the user has, so a bundle that later
      gains a plugin can offer an update even though every plugin already
      installed is current. */
  installPackages(ids: string[], bundleId?: string): void;
  /** Stop the running install at the next checkpoint. Packages already
      installed stay installed. */
  cancelInstall(): void;
  /** Delete the named packages' plugin files. Only files Plectrify recorded
      installing are removed, so a plugin the user installed by other means is
      never touched. A plugin loaded in the live rack holds its file open and
      reports `locked` instead of being half-removed. */
  uninstallPackages(ids: string[]): void;

  /** Open the native audio-device settings dialog (native engine only). */
  openAudioSettings(): void;

  /** Hand an `https://` URL to the user's default browser. The host UI has no
      tabs, so an ordinary link would navigate the app itself away. */
  openExternalUrl(url: string): void;

  /** Begin an OS-native window resize from the given edge, in response to a
      pointer-down on an invisible edge strip (native engine only). The OS
      takes over the drag from there. */
  startWindowResize(edge: WindowResizeEdge): void;

  /** Update application preferences. These are persisted independently of
      rigs and the working session. */
  setAppSettings(settings: Partial<AppSettings>): void;
  /** Subscribe to application preferences. Returns an unsubscribe function. */
  subscribeAppSettings(listener: (settings: AppSettings) => void): () => void;

  /** Subscribe to the host's own facts — version, build provenance, machine,
      audio device, plugin-library sizes. Replays the last known value, so a late
      subscriber (the About dialog) needs no re-request. Returns an unsubscribe
      function. */
  subscribeAppInfo(listener: (info: AppInfo) => void): () => void;
  /** Ask the engine to re-push its facts. They change (audio device, plugin
      counts) and a push can be dropped while the window is occluded, so the
      About dialog asks again when it opens rather than trusting the cache. */
  refreshAppInfo(): void;

  /** Drive Auto Standby directly. 'wake' brings the rig back (the only thing
      the user can click while it is parked); 'sleep' engages standby now,
      without waiting out the countdown; 'activity' just restarts the countdown
      and is what the UI's throttled interaction ping sends.

      The standby *preference* travels through setAppSettings — this is only for
      the verbs, which "absent field means no change" cannot express. */
  standbyCommand(action: 'wake' | 'sleep' | 'activity'): void;

  /** Subscribe to the raw MIDI trigger stream: batches of CC / PC / note-on
      messages from every connected MIDI input, already filtered engine-side.
      A stream, not state — nothing is replayed on subscribe. What a message
      *means* (rig/scene switch, tuner toggle, MIDI learn) is decided by the
      subscriber against AppSettings.midiBindings (see midi.ts). */
  subscribeMidiEvents(listener: (events: MidiEvent[]) => void): () => void;
  /** Subscribe to the names of the auto-opened MIDI inputs (every device on
      the machine, hot-plug included). Replays the last known list. */
  subscribeMidiDevices(listener: (devices: string[]) => void): () => void;
  /** Ask the engine to re-push the open-input list — a push can be dropped
      while the window is occluded, so the MIDI settings dialog asks again when
      it opens rather than trusting the cache (same pattern as refreshAppInfo). */
  refreshMidiDevices(): void;

  /** Drive the built-in looper. 'toggle' is the pedal's main action, cycling
      record -> play -> overdub (and restarting a stopped loop); the other
      verbs are direct. Verbs rather than state, like standbyCommand — the
      looper's actual state comes back through subscribeStatus. */
  looperCommand(action: 'toggle' | 'stop' | 'clear' | 'undo'): void;

  /** Toggle the practice click or restart its bar on the next audio block. */
  metronomeCommand(action: 'toggle' | 'sync'): void;

  /** Subscribe to the looper's session archive (loops saved by 'clear'),
      newest first. Replays the current list. Returns an unsubscribe function. */
  subscribeLooperSessions(listener: (sessions: LooperSession[]) => void): () => void;
  /** Load an archived session back into the looper. It starts playing from
      the beginning. A loop currently held is archived first
      through the normal clear path, so loading never destroys audio. Resolves
      true once the loop is actually in place. */
  loadLooperSession(id: string): Promise<boolean>;
  /** Forget an archived session and delete its audio file. */
  deleteLooperSession(id: string): void;
  /** Change an archived session's display name. Empty names are ignored. */
  renameLooperSession(id: string, name: string): void;
  /** Exempt a session from the archive's size cap (kept = never
      auto-discarded), or re-subject it. */
  setLooperSessionKept(id: string, kept: boolean): void;
  /** Open the sessions folder in the OS file browser (native engine only). */
  revealLooperSessions(): void;

  /** Update one or more host controls, including the transient MIDI tuner and
      the looper's placement and arming preferences. */
  setStatus(status: Partial<SettableStatus>): void;
  /** Subscribe to live master meters and tuner state. */
  subscribeStatus(listener: (status: StatusState) => void): () => void;

  /** Subscribe to rack changes (incl. values pushed from the engine).
      Returns an unsubscribe function. */
  subscribeRack(listener: (rack: RackModule[]) => void): () => void;
}
