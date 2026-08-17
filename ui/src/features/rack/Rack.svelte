<script lang="ts">
  import { ArrowsLeftRightIcon, ArrowsSplitIcon, PlusIcon, SwapIcon } from 'phosphor-svelte';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { fade, slide } from 'svelte/transition';
  import { deviceScale, snapThickness } from '../../lib/pixelSnap';
  import { devicePixelRatio, trackDevicePixelRatio } from '../../lib/devicePixels.svelte';
  import {
    FAN_COLUMN_PX,
    ROUTE_THICKNESS,
    actionStemHeight,
    actionStemWidth,
    laneLineTop,
    mergePath,
    snapRouteGeometry,
    splitPath,
    trunkTop,
    type FlowMetrics,
    type RouteGeometry,
    type RouteGrid,
  } from './routeGeometry';
  import Button from '../../lib/components/Button.svelte';
  import ConfirmDialog from '../../lib/components/ConfirmDialog.svelte';
  import IconButton from '../../lib/components/IconButton.svelte';
  import TaskDialog from '../../lib/components/TaskDialog.svelte';
  import type {
    EngineBridge,
    ModuleInsertTarget,
    ModuleMoveTarget,
    PluginScanState,
  } from '../../lib/engine/EngineBridge';
  import type {
    AppSettings,
    BlacklistedPlugin,
    EngineBusyState,
    MidiActionId,
    MidiEvent,
    Patch,
    PluginInfo,
    Rig,
    RackModule,
    RoutingState,
    Scene,
    SceneState,
    Song,
    SplitGroup,
    StatusState,
  } from '../../lib/engine/types';
  import { MAX_TEMPLATE_KNOBS, MIN_DRAWER_HEIGHT } from '../../lib/engine/appSettings';
  import { normalizePositions } from '../../lib/engine/knobLayout';
  import type { CatalogueState } from '../../lib/engine/catalogue';
  import { patchGroups, type PatchGroup } from '../../lib/engine/drawerGroups';
  import { isPress, matchMidi, stepIndex, triggerOf } from '../../lib/engine/midi';
  import { playOrder, stepSong } from '../../lib/engine/songs';
  import {
    buildContentTargets,
    findContentBindings,
    resolveContentMidi,
    triggerKey,
    type ContentCommand,
  } from '../../lib/engine/contentMidi';
  import LiveTunerOverlay from '../status/LiveTunerOverlay.svelte';
  import { nextRigName } from '../../lib/engine/rigNames';
  import { sceneMatchesLive } from '../../lib/engine/scenes';
  import { canRevertViaScene, rigSignature } from '../../lib/engine/rigSignature';
  import ModuleCard from '../module/ModuleCard.svelte';
  import ModuleDrawer from '../drawer/ModuleDrawer.svelte';
  import { revealPackageInPanel } from '../plugins/reveal';
  import { revealBrowseInDrawer } from '../drawer/reveal';
  import LaneSwitchButton from './LaneSwitchButton.svelte';
  import BlacklistDialog from './BlacklistDialog.svelte';
  import MixStrip from './MixStrip.svelte';
  import SplitModeToggle, { type SplitMode } from './SplitModeToggle.svelte';
  import TopToolbar from './TopToolbar.svelte';
  import { isNamPlugin } from '../../lib/engine/tone3000';

  interface Props {
    engine: EngineBridge;
    rack: RackModule[];
    routing: RoutingState;
    patches: Patch[];
    rigs: Rig[];
    plugins: PluginInfo[];
    /** The plugin catalogue (App-owned), for the module drawer and a module's
        patch menu: patches file under their package's category heading. */
    catalogue: CatalogueState;
    /** True while a fresh installation is fetching the starter bundle on its
        own. The empty rack says so: the plugins are minutes away, and an app
        that silently offered nothing to drag would read as broken rather than
        as busy. */
    starterInstalling: boolean;
    busy: EngineBusyState;
    status: StatusState;
    appSettings: AppSettings;
    sceneState: SceneState;
    /** Plugin-internal drift (engine-owned, see subscribeToneDirty): a plugin
        changed its own state in a way the rack signature can't see, so it
        counts toward the rig's unsaved changes. */
    toneDirty: boolean;
    /** Scan progress (App-owned, the Info panel's diagnostics need it too);
        the scan dialog here renders it. */
    pluginScan: PluginScanState;
    /** Plugin files the scanner skips (engine-owned, mirrored in App); the
        blacklist dialog here acts on it. */
    blacklistedPlugins: BlacklistedPlugin[];
    /** Open the TONE3000 browser. `moduleId` names the module a chosen tone
        should replace in place; absent means it becomes a drawer patch. */
    onBrowseTone3000: (moduleId?: string, insertAt?: ModuleMoveTarget) => void;
    /** Patch ids whose TONE3000 capture is missing from disk, and the action
        that fetches it again. */
    missingCaptures?: ReadonlySet<string>;
    onRepairPatch?: (patchId: string) => void;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Development-only action that snapshots the visible DOM as HTML. */
    onExportView?: () => void | Promise<void>;
    /** True while a MIDI learn outside this component is armed (the tuner's,
        the looper's, or the sidebar MIDI settings view's). Live MIDI dispatch
        pauses so the press being captured can't also fire whatever it was
        bound to before. */
    midiLearnActive?: boolean;
    /** Bindable mirror of this component's own armed rig-content learn, so
        App can tell the status bar to refuse arming the tuner's learn while
        a knob/module/lane learn is listening (and vice versa). To disarm it
        from outside, App calls the exported disarmContentLearn(). */
    rackMidiLearning?: boolean;
    /** The tools sidebar (App-owned), rendered beside the viewport *below*
        the toolbar so the toolbar keeps the full window width. A snippet
        rather than a child component so its state and bindings stay in App. */
    toolsSidebar?: Snippet;
    /** True while a sidebar tool is maximized over the workspace (stage
        view). The busy dialog skips rendering then: the staged panel spans
        the whole row the dialog would veil, and it is exactly what the
        player is watching mid rig switch. */
    toolStaged?: boolean;
    /** Fired when a looper action arrives from a MIDI pedal. App raises the
        sidebar's maximized stage view: a foot on the looper switch means the
        player's eyes are about to look for the looper's state. */
    onLooperMidiAction?: () => void;
    /** Reports a metronome MIDI verb so App can own tap history and stage it. */
    onMetronomeMidiAction?: (action: 'toggle' | 'tap' | 'tempoUp' | 'tempoDown') => void;
    /** Fired when the song transport is walked from a pedal. App raises the
        stage view: a foot on that switch means the player is about to look for
        the next song's name. */
    onSetlistMidiAction?: () => void;
    /** A pedal press on a tool's Maximize mapping. App toggles that tool's
        stage view — the same button the panel header offers, from the floor. */
    onToolMaximizeMidiAction?: (tool: 'looper' | 'metronome' | 'setlist') => void;
  }

  let {
    engine,
    rack,
    routing,
    patches,
    rigs,
    plugins,
    catalogue,
    starterInstalling,
    busy,
    status,
    appSettings,
    sceneState,
    toneDirty,
    pluginScan,
    blacklistedPlugins,
    onBrowseTone3000,
    missingCaptures,
    onRepairPatch,
    onSetAppSettings,
    onExportView,
    midiLearnActive = false,
    rackMidiLearning = $bindable(false),
    toolsSidebar,
    toolStaged = false,
    onLooperMidiAction,
    onMetronomeMidiAction,
    onSetlistMidiAction,
    onToolMaximizeMidiAction,
  }: Props = $props();
  let scanDialogOpen = $state(false);
  let blacklistOpen = $state(false);
  // The empty rack's primary action — the accent-filled prompt look the old
  // module picker's prominent trigger established.
  const promptButtonClass =
    'min-w-[9.75rem] justify-center border-accent bg-accent font-semibold text-accent-ink shadow-[0_4px_12px_color-mix(in_srgb,var(--color-void)_35%,transparent),inset_0_-1px_0_color-mix(in_srgb,var(--color-void)_28%,transparent)] hover:border-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_88%,var(--color-ink))] hover:text-accent-ink hover:shadow-[0_5px_14px_color-mix(in_srgb,var(--color-void)_42%,transparent),inset_0_-1px_0_color-mix(in_srgb,var(--color-void)_20%,transparent)]';
  /** Live width of the tool rail plus whatever panel is open, in shell pixels.
      Feeds `--tools-w`, which keeps the busy scrim off the sidebar. */
  let toolsWidth = $state(0);
  /** Live height of the viewport column, in shell pixels. The drawer may
      grow to fill it — measured, then converted back to the drawer's own
      pre-chrome-scale pixels, minus a hair so the frame never overflows.
      The viewport itself sits in a shrinkable clipper (see the markup), so
      "full" genuinely reaches the toolbar instead of stopping at the
      viewport's padding floor. */
  let workspaceColHeight = $state(0);
  const drawerMaxHeight = $derived(
    Math.max(MIN_DRAWER_HEIGHT, workspaceColHeight / (appSettings.uiScale || 1) - 8),
  );

  /** True while the drawer is sunk out of the way for an insert drag. Set a
      breath *after* dragstart, never synchronously inside it: the drag's
      source tile lives in the drawer, and collapsing its container in the
      same task the drag begins aborts a native drag outright. */
  let insertDrawerSunk = $state(false);
  let sinkDrawerTimer = 0;

  function startInsertDrag(payload: { pluginId: string; patchId?: string; tone3000?: boolean }) {
    rackDrag = { kind: 'insert', ...payload };
    clearTimeout(sinkDrawerTimer);
    sinkDrawerTimer = window.setTimeout(() => {
      if (rackDrag?.kind === 'insert') insertDrawerSunk = true;
    }, 50);
  }

  /** Each plugin's patches, grouped and hand-ordered exactly as the drawer
      files them, for that plugin's modules to switch between. Resolved once
      per plugin rather than per card: several modules can host the same
      plugin, and they all get the same answer. */
  const patchSectionsByPlugin = $derived.by(() => {
    const byPlugin = new Map<string, Patch[]>();
    for (const patch of patches) {
      const list = byPlugin.get(patch.pluginName);
      if (list) list.push(patch);
      else byPlugin.set(patch.pluginName, [patch]);
    }
    const out = new Map<string, PatchGroup[]>();
    for (const [pluginName, list] of byPlugin)
      out.set(
        pluginName,
        patchGroups(list, catalogue.items, plugins, appSettings.drawerPatchOrder),
      );
    return out;
  });

  // Trigger-key → knob/module/lane over the live rig. Rig content owns its
  // trigger identities outright: an event whose key is in this table is
  // consumed even when it resolves to no command (a release), so a
  // footswitch's release can never fall through and fire a global action.
  const contentTargets = $derived(buildContentTargets(rack, routing));

  // One armed rig-content learn across the whole rack (knob, module bypass,
  // or lane trigger). Edit-mode only; mutually exclusive with the tuner's
  // learn (midiLearnActive) and the MIDI dialog.
  type ContentLearn =
    | { kind: 'knob'; moduleId: string; knobId: string; isBoolean: boolean }
    | { kind: 'module'; moduleId: string }
    | { kind: 'lane'; laneId: string };
  let contentLearn = $state<ContentLearn | null>(null);

  function setContentLearn(next: ContentLearn | null) {
    contentLearn = next;
    rackMidiLearning = next !== null;
  }

  function contentLearnMatches(a: ContentLearn, b: ContentLearn): boolean {
    return (
      (a.kind === 'knob' &&
        b.kind === 'knob' &&
        a.moduleId === b.moduleId &&
        a.knobId === b.knobId) ||
      (a.kind === 'module' && b.kind === 'module' && a.moduleId === b.moduleId) ||
      (a.kind === 'lane' && b.kind === 'lane' && a.laneId === b.laneId)
    );
  }

  /** Arm a learn, disarm it when its own button is clicked again. */
  function toggleContentLearn(next: ContentLearn) {
    if (contentLearn && contentLearnMatches(contentLearn, next)) {
      setContentLearn(null);
      return;
    }
    if (!editMode || midiLearnActive) return;
    setContentLearn(next);
  }

  /** Disarm the rack's own content learn from outside (App calls this when
      the sidebar's MIDI settings view opens — one armed learn app-wide, and
      that view brings its own Learn buttons). */
  export function disarmContentLearn() {
    setContentLearn(null);
  }

  // An armed learn must not outlive its target or edit mode: leaving edit
  // hides every learn button, and the module/lane can be deleted mid-learn.
  // UI-state sync (not an engine subscription), so an effect is the right tool.
  $effect(() => {
    const learn = contentLearn;
    if (learn === null) return;
    const alive =
      editMode &&
      (learn.kind === 'knob'
        ? rack.some(
            (m) => m.id === learn.moduleId && m.params.some((p) => p.knobId === learn.knobId),
          )
        : learn.kind === 'module'
          ? rack.some((m) => m.id === learn.moduleId)
          : routing.groups.some((g) => g.lanes.some((l) => l.id === learn.laneId)));
    if (!alive) setContentLearn(null);
  });

  /** First acceptable message while armed becomes the binding. Continuous
      knobs accept any CC (a pedal sweep starts at any value); boolean knobs,
      modules and lanes accept a press of any kind. The trigger is stolen from
      every other rig-content owner first, so one switch never drives two
      things by accident. Global action bindings are deliberately left alone —
      content-first dispatch precedence already mutes them for this trigger. */
  function captureContentLearn(event: MidiEvent) {
    const learn = contentLearn;
    if (learn === null) return;
    const acceptable =
      learn.kind === 'knob' && !learn.isBoolean ? event.type === 'cc' : isPress(event);
    if (!acceptable) return;

    const trigger = triggerOf(event);
    for (const owner of findContentBindings(rack, routing, trigger)) {
      if (owner.kind === 'knob') engine.setKnobMidi(owner.moduleId, owner.knobId, null);
      else if (owner.kind === 'module') engine.setModuleMidi(owner.moduleId, null);
      else engine.setLaneMidi(owner.laneId, null);
    }

    if (learn.kind === 'knob') engine.setKnobMidi(learn.moduleId, learn.knobId, trigger);
    else if (learn.kind === 'module') engine.setModuleMidi(learn.moduleId, trigger);
    else engine.setLaneMidi(learn.laneId, trigger);
    setContentLearn(null);
  }

  function runContentCommand(cmd: ContentCommand) {
    if (cmd.kind === 'setParam') {
      engine.setParam(cmd.moduleId, cmd.paramIndex, cmd.value);
      return;
    }
    if (cmd.kind === 'toggleParam') {
      const value = rack
        .find((m) => m.id === cmd.moduleId)
        ?.params.find((p) => p.paramIndex === cmd.paramIndex)?.value;
      if (value !== undefined) engine.setParam(cmd.moduleId, cmd.paramIndex, value >= 0.5 ? 0 : 1);
      return;
    }
    if (cmd.kind === 'toggleBypass') {
      const m = rack.find((candidate) => candidate.id === cmd.moduleId);
      if (m) toggleBypass(m, !m.bypassed);
      return;
    }
    const group = groups.find((g) => g.id === cmd.groupId);
    if (group) requestLaneSwitch(group, cmd.laneId);
  }

  onMount(() =>
    engine.subscribeMidiEvents((events) => {
      // Snapshotted per batch: a successful capture clears contentLearn, and
      // without the snapshot the rest of a multi-message gesture (a controller
      // sending CC+PC per switch) would fall through to normal dispatch.
      const learnArmed = contentLearn !== null;
      for (const event of events) {
        // An armed content learn captures (or ignores) everything — including
        // the remainder of the batch after the capture, which
        // captureContentLearn drops once contentLearn is cleared.
        if (learnArmed) {
          captureContentLearn(event);
          continue;
        }

        // Rig content first; it consumes its trigger identities outright.
        // Live controls, like the tuner: they work in edit mode too, but drop
        // while busy, parked, or behind any modal/learn.
        if (contentTargets.has(triggerKey(triggerOf(event)))) {
          if (!shortcutsEnabled) continue;
          const cmd = resolveContentMidi(contentTargets, event);
          if (cmd) runContentCommand(cmd);
          continue;
        }

        const action = matchMidi(appSettings.midiBindings, event);
        if (action !== null) dispatchMidiAction(action);
      }
    }),
  );

  function dispatchMidiAction(action: MidiActionId) {
    if (action === 'tunerToggle') {
      // Once the stage tuner is up, the same foot press must always be able to
      // dismiss it — even if a modal or rack load appeared in the meantime.
      // Activation still obeys the normal live-control guards.
      if (status.midiTunerActive || shortcutsEnabled)
        engine.setStatus({ midiTunerActive: !status.midiTunerActive });
      return;
    }

    // The mute is the panic control, so it is ungated in both directions: a
    // player reaching for the footswitch with a room listening must be able to
    // kill the output whatever is on screen, and get it back the same way. A
    // press while the feedback guard is latched clears the latch instead, which
    // is exactly what the pill's own click does.
    if (action === 'outputMute') {
      if (status.feedbackMuted) engine.setStatus({ feedbackMuted: false, outputMuted: false });
      else engine.setStatus({ outputMuted: !status.outputMuted });
      return;
    }

    if (!shortcutsEnabled) return;

    // Maximizing is a view action, so it works wherever the tools do — the
    // player raises the looper or the tempo onto the whole screen, and the same
    // switch drops it again. No rig state is touched, so no edit-mode gate.
    if (
      action === 'looperMaximize' ||
      action === 'metronomeMaximize' ||
      action === 'songMaximize'
    ) {
      onToolMaximizeMidiAction?.(
        action === 'looperMaximize'
          ? 'looper'
          : action === 'metronomeMaximize'
            ? 'metronome'
            : 'setlist',
      );
      return;
    }

    // The looper is a live control like the tuner: it must work in Edit mode
    // too — practising with the looper is exactly when the rack is being
    // tweaked — but it obeys the modal/busy/learn guards above.
    if (
      action === 'looperToggle' ||
      action === 'looperStop' ||
      action === 'looperClear' ||
      action === 'looperUndo'
    ) {
      engine.looperCommand(
        action.slice('looper'.length).toLowerCase() as 'toggle' | 'stop' | 'clear' | 'undo',
      );
      onLooperMidiAction?.();
      return;
    }

    if (action === 'metronomeToggle') {
      engine.metronomeCommand('toggle');
      onMetronomeMidiAction?.('toggle');
      return;
    }
    if (action === 'metronomeTapTempo') {
      onMetronomeMidiAction?.('tap');
      return;
    }
    if (action === 'metronomeTempoUp' || action === 'metronomeTempoDown') {
      onMetronomeMidiAction?.(action === 'metronomeTempoUp' ? 'tempoUp' : 'tempoDown');
      return;
    }

    // Rig/scene switching from the floor is Perform-mode only, exactly like
    // the keyboard shortcuts — a foot press must never raise a confirmation
    // dialog, and in perform mode loadRig/requestSceneSwitch commit directly.
    if (editMode) return;

    if (action === 'rigNext' || action === 'rigPrev') {
      const from = rigs.findIndex((r) => r.id === activeRigId);
      const to = stepIndex(from, rigs.length, action === 'rigNext' ? 1 : -1);
      if (to >= 0 && rigs[to].id !== activeRigId) loadRig(rigs[to].id);
      return;
    }
    if (action.startsWith('rig:')) {
      const rig = rigs[Number(action.slice('rig:'.length))];
      // Re-pressing the active rig is a no-op: a rig load is a multi-second
      // chain rebuild, and an accidental double-tap must not drop the audio.
      if (rig && rig.id !== activeRigId) loadRig(rig.id);
      return;
    }

    // Walking the songs is rig/scene switching under another name, so it sits
    // below the edit-mode gate with the rest of it.
    if (action === 'songNext' || action === 'songPrev') {
      const order = playOrder(appSettings);
      const target = stepSong(order, appSettings.activeSongId, action === 'songNext' ? 1 : -1);
      if (target) void recallSong(target);
      onSetlistMidiAction?.();
      return;
    }

    if (action === 'sceneNext' || action === 'scenePrev') {
      const scenes = sceneState.scenes;
      const from = scenes.findIndex((s) => s.id === sceneState.activeSceneId);
      const to = stepIndex(from, scenes.length, action === 'sceneNext' ? 1 : -1);
      if (to >= 0) requestSceneSwitch(scenes[to].id);
      return;
    }
    if (action.startsWith('scene:')) {
      // Re-applying the active scene is cheap and idempotent, same as a click.
      const scene = sceneState.scenes[Number(action.slice('scene:'.length))];
      if (scene) requestSceneSwitch(scene.id);
    }
  }

  function scanPlugins() {
    pluginScan = { status: 'scanning', pluginCount: plugins.length };
    scanDialogOpen = true;
    engine.scanPlugins();
  }

  /** Clearing entries rescans engine-side, so this shows the same progress the
      Rescan action does — and steps out of the way, since the scan dialog is
      what reports how it went. */
  function retryBlacklisted(paths: string[]) {
    blacklistOpen = false;
    pluginScan = { status: 'scanning', pluginCount: plugins.length };
    scanDialogOpen = true;
    engine.retryBlacklistedPlugins(paths);
  }
  const loadingPercent = $derived(
    busy.loading && busy.loading.total > 0
      ? Math.round((busy.loading.current / busy.loading.total) * 100)
      : 0,
  );

  // --- Parallel routing layout ---------------------------------------------
  // The flat rack splits into three regions around the (single) parallel group:
  // serial modules before it, the lanes, and serial modules after it. Lane
  // Membership is by `laneId`; each group's position is counted over serial
  // (non-laned) modules, so multiple groups can be rendered in chain order.
  const groups = $derived([...routing.groups].sort((a, b) => a.position - b.position));
  const hasSplit = $derived(groups.length > 0);
  const rackIsEmpty = $derived(rack.length === 0 && !hasSplit);
  const serial = $derived(rack.filter((m) => !m.laneId));
  // Serial modules ahead of the first split — the whole chain when unsplit.
  const headSegment = $derived(serial.slice(0, groups[0]?.position ?? serial.length));
  const laneModules = (laneId: string) => rack.filter((m) => m.laneId === laneId);
  const laneIsAudible = (groupId: string, laneId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    const lane = group?.lanes.find((candidate) => candidate.id === laneId);
    const selected = !group?.activeLaneId || group.activeLaneId === laneId;
    return (
      !!lane &&
      selected &&
      !lane.muted &&
      (!group?.lanes.some((item) => item.soloed) || lane.soloed)
    );
  };

  /** Paint order for a fan's paths: muted lanes first. Every path in a fan
      retraces the same run out of the split junction, so whichever is drawn
      last owns the shared segment — and a muted route is opaque, which would
      let it grey out the audible lane it overlaps. Sorting is stable, so lanes
      otherwise keep their own order. */
  const fanOrder = (group: SplitGroup) =>
    group.lanes
      .map((lane, index) => ({ lane, index }))
      .sort(
        (a, b) =>
          Number(laneIsAudible(group.id, a.lane.id)) - Number(laneIsAudible(group.id, b.lane.id)),
      );

  // Lane switches and bypass toggles only take effect once the engine's
  // rackChanged echo returns. Remember each request and treat it as pending
  // while it disagrees with the engine-confirmed state — so the spinner ends
  // the moment the echo lands, with no cleanup effect. The timeouts only
  // garbage-collect requests the engine rejected (those never echo back).
  // A requested lane id of '' means mix mode, matching the empty string the
  // engine itself uses for "no active lane".
  let pendingLaneSwitch = $state<Record<string, string>>({});
  let pendingBypass = $state<Record<string, boolean>>({});

  const laneSwitchPending = (group: SplitGroup, laneId: string) =>
    pendingLaneSwitch[group.id] === laneId && group.activeLaneId !== laneId;

  const splitMode = (group: SplitGroup): SplitMode => (group.activeLaneId ? 'switch' : 'mix');

  /** Which mode the engine has been asked for but has not confirmed yet. */
  function splitModePending(group: SplitGroup): SplitMode | null {
    const requested = pendingLaneSwitch[group.id];
    if (requested === undefined) return null;
    const requestedMode: SplitMode = requested ? 'switch' : 'mix';
    return requestedMode === splitMode(group) ? null : requestedMode;
  }

  /** Send a lane-switch request unless one is already in flight. */
  function requestLaneSwitch(group: SplitGroup, laneId: string) {
    const inFlight = pendingLaneSwitch[group.id];
    if ((group.activeLaneId ?? '') === laneId) return;
    if (inFlight !== undefined && inFlight !== (group.activeLaneId ?? '')) return;
    pendingLaneSwitch[group.id] = laneId;
    engine.setLaneSwitch(group.id, laneId || null);
    setTimeout(() => {
      if (pendingLaneSwitch[group.id] === laneId) delete pendingLaneSwitch[group.id];
    }, 3000);
  }

  // Coming back to switch mode should land on the lane you were last using
  // rather than snapping to the first one.
  let lastActiveLane = $state<Record<string, string>>({});
  $effect(() => {
    for (const group of groups)
      if (group.activeLaneId) lastActiveLane[group.id] = group.activeLaneId;
  });

  function setSplitMode(group: SplitGroup, mode: SplitMode) {
    if (mode === 'mix') return requestLaneSwitch(group, '');
    const remembered = lastActiveLane[group.id];
    const target = group.lanes.some((lane) => lane.id === remembered)
      ? remembered
      : group.lanes[0]?.id;
    if (target) requestLaneSwitch(group, target);
  }

  const bypassPending = (m: RackModule) =>
    m.id in pendingBypass && pendingBypass[m.id] !== m.bypassed;

  function toggleBypass(m: RackModule, bypassed: boolean) {
    if (m.bypassed === bypassed || bypassPending(m)) return;
    pendingBypass[m.id] = bypassed;
    engine.setBypass(m.id, bypassed);
    setTimeout(() => {
      if (pendingBypass[m.id] === bypassed) delete pendingBypass[m.id];
    }, 3000);
  }

  let routeGeometries = $state<Record<string, RouteGeometry>>({});
  let flow = $state<FlowMetrics>({ height: 0, originY: 0 });

  /** Each split group's span within `.rack-flow`, which is the stretch of trunk
      the group replaces. Local css px, measured from the trunk's own left edge
      so it can be masked with them directly. */
  let trunkGaps = $state<Record<string, { left: number; right: number }>>({});

  /** Mirrors `.rack-flow::before { left: 2rem; right: 2rem }`. */
  const TRUNK_INSET_PX = 32;

  /** Cuts the trunk out where each split group sits, so the serial line
      terminates at the split and resumes at the merge instead of implying a
      hidden bypass between them.

      A mask rather than something painted over the top, which is what this was:
      an opaque band in `--color-space` hid the trunk perfectly well on a flat
      page, but the page carries a faint radial wash, and a flat fill over a
      gradient is a dark bar the width of the group. Nothing paints here now —
      the trunk simply is not there — so the wash, and anything else behind the
      rack, comes through untouched. Masking also takes the glow with it, which
      is why the band had to be 20px tall to begin with. */
  const trunkMask = $derived.by(() => {
    const spans = groups
      .map((group) => trunkGaps[group.id])
      .filter((span) => span !== undefined)
      .map((span) => ({ left: span.left - TRUNK_INSET_PX, right: span.right - TRUNK_INSET_PX }))
      .sort((a, b) => a.left - b.left);
    if (spans.length === 0) return undefined;
    const stops: string[] = [];
    let x = 0;
    for (const span of spans) {
      // Clamped and carried forward: two groups whose measurements briefly
      // overlap during a layout pass would otherwise emit a gradient whose
      // stops run backwards, which paints nothing at all.
      const left = Math.max(x, span.left);
      const right = Math.max(left, span.right);
      stops.push(`#000 ${x}px ${left}px`, `transparent ${left}px ${right}px`);
      x = right;
    }
    stops.push(`#000 ${x}px`);
    return `linear-gradient(to right, ${stops.join(', ')})`;
  });

  /** Measure actual grid-row centres so routes stay attached when differently
      sized plugin cards or edit mode change a lane's height, and so the SVG
      fans land on the same pixel rows as the CSS lines they join.

      Rects, not `offsetTop`/`offsetHeight`: those round to whole pixels, and a
      lane centre that rounds away from the subpixel position its own line
      resolves to is precisely the drift this measurement exists to remove. The
      rect pixels do include the rack's CSS zoom, so everything is divided back
      out — feeding them into CSS lengths unscaled would scale the add-lane stem
      a second time. Positions are taken relative to `.rack-flow` because the
      trunk, the fans and the lane lines can only join seamlessly if they round
      onto one shared grid rather than each box's own origin. */
  function measureRoutes(groupId: string): Attachment<HTMLDivElement> {
    return (node) => {
      const observed = new Set<HTMLElement>([node]);
      const measure = () => {
        const chain = node.closest<HTMLElement>('.rack-flow');
        if (!chain) return;
        const connectorIn = node.querySelector<HTMLElement>('.lane-connector-in');
        const connectorOut = node.querySelector<HTMLElement>('.lane-connector-out');
        const rows = [...node.querySelectorAll<HTMLElement>('.lane-row')];
        // Two lanes can swap heights without the grid's own height moving, so
        // watch the rows as well. Diffed rather than re-observed wholesale:
        // observing a target fires the callback immediately, and disconnecting
        // then re-observing everything each pass would never settle.
        for (const row of rows) {
          if (observed.has(row)) continue;
          observer.observe(row);
          observed.add(row);
        }
        for (const stale of observed) {
          if (stale === node || rows.includes(stale)) continue;
          observer.unobserve(stale);
          observed.delete(stale);
        }
        // Read every rect before writing any state: reads inside a resize
        // callback are free because layout is already settled, but interleaving
        // them with writes would force it again per lane.
        const dpr = devicePixelRatio();
        const flowRect = chain.getBoundingClientRect();
        const routesRect = node.getBoundingClientRect();
        const inRect = connectorIn?.getBoundingClientRect();
        const outRect = connectorOut?.getBoundingClientRect();
        const rowRects = rows.map((row) => row.getBoundingClientRect());
        // The connector columns are exactly where the two fans are positioned,
        // and unlike the fans themselves they exist before the first measurement.
        routeGeometries[groupId] = snapRouteGeometry(
          {
            width: (inRect?.width ?? FAN_COLUMN_PX * rackZoom) / rackZoom,
            height: routesRect.height / rackZoom,
            top: (routesRect.top - flowRect.top) / rackZoom,
            flowHeight: flowRect.height / rackZoom,
            laneTops: rowRects.map((rect) => (rect.top - flowRect.top) / rackZoom),
            laneCenters: rowRects.map(
              (rect) => (rect.top - flowRect.top + rect.height / 2) / rackZoom,
            ),
            originY: flowRect.top * dpr,
            splitOriginX: (inRect?.left ?? routesRect.left) * dpr,
            mergeOriginX: (outRect?.left ?? routesRect.right - FAN_COLUMN_PX * rackZoom) * dpr,
          },
          routeGrid,
        );
        const block = node.closest<HTMLElement>('.split-block');
        if (block) {
          const blockRect = block.getBoundingClientRect();
          trunkGaps[groupId] = {
            left: (blockRect.left - flowRect.left) / rackZoom,
            right: (blockRect.right - flowRect.left) / rackZoom,
          };
        }
      };
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      // None of these resize this group's own box: a zoom step or a monitor
      // change moves the pixel grid under it, a taller group elsewhere in the
      // chain re-centres it without changing its height, and scrolling or
      // resizing the viewport shifts where the whole rack lands on the screen.
      $effect(() => {
        routeGrid;
        flow;
        measure();
      });
      return () => {
        observer.disconnect();
        // A stale span would keep a hole in the trunk where the group used to be.
        delete trunkGaps[groupId];
      };
    };
  }

  /** The trunk spans the whole chain, so `.rack-flow` is the box every route is
      snapped against — both its height and, since the routes are aligned to
      physical pixels, where its top edge actually lands on screen.

      Its own size is only half of that: auto-margin centring moves it whenever
      the viewport resizes or its padding changes, and panning moves it without
      any resize at all, so the scroller is watched too. */
  function measureFlow(node: HTMLElement) {
    const viewport = node.closest<HTMLElement>('.rack-viewport');
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      flow = {
        height: rect.height / rackZoom,
        originY: rect.top * devicePixelRatio(),
      };
    };
    // Scroll fires far faster than it can matter; one measurement per frame is
    // both enough and cheap, since it is a single rect read.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (viewport) {
      observer.observe(viewport);
      viewport.addEventListener('scroll', schedule, { passive: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport?.removeEventListener('scroll', schedule);
    };
  }

  // Valid engine IDs remain stable keys. The suffix only exists while an old
  // duplicated native session is being migrated by JuceEngine, preventing the
  // transient corrupt snapshot from taking down the whole component tree.
  function moduleRenderKey(segment: RackModule[], module: RackModule, index: number): string {
    const occurrence = segment
      .slice(0, index)
      .filter((candidate) => candidate.id === module.id).length;
    return occurrence === 0 ? module.id : `${module.id}:duplicate-${occurrence}`;
  }

  // --- Drag onto any insert gap (edit mode only) ----------------------------
  // Two drags share the rack's drop zones: moving an existing module (from a
  // card's move handle, see ModuleCard) and inserting a new one (a patch tile
  // or plugin chip from the module drawer). Both span the whole rack, so the
  // in-flight state lives here — and it is the state, not dataTransfer, that
  // the drop reads, because a payload is unreadable until the drop lands.
  // `dragOverTargetKey` is tracked explicitly because :hover is not updated
  // while an HTML5 drag is in flight.
  type RackDrag =
    | { kind: 'move'; moduleId: string }
    | { kind: 'insert'; pluginId: string; patchId?: string; tone3000?: boolean };
  let rackDrag = $state<RackDrag | null>(null);
  let dragOverTargetKey = $state<string | null>(null);
  // The move drag's module id, or null: what the flank-inert logic and the
  // add-lane drop spot key on — neither applies to an insert drag.
  const draggingModuleId = $derived(rackDrag?.kind === 'move' ? rackDrag.moduleId : null);
  // Gap targets are rebuilt object literals every render, so the highlight is
  // keyed by their content instead of their identity.
  const targetKey = (target: ModuleMoveTarget) => JSON.stringify(target);
  // The remove zone's key in dragOverTargetKey. Cannot collide with a gap's:
  // every real target serialises to a JSON object literal.
  const DELETE_TARGET_KEY = 'delete';

  function endRackDrag() {
    rackDrag = null;
    dragOverTargetKey = null;
    cardTargetId = null;
    clearTimeout(sinkDrawerTimer);
    insertDrawerSunk = false;
  }

  // --- Drop onto a module ---------------------------------------------------
  // The gaps say "add one here"; a card says "make this one that" (an insert
  // drag: the module is replaced) or "trade places with this one" (a move
  // drag: the two modules exchange positions, each keeping everything it
  // carries). Both are gestures a gap cannot express — a gap can only put a
  // module somewhere, never say what steps aside in return.
  let cardTargetId = $state<string | null>(null);

  /** Whether the drag in flight can land on this module. The TONE3000 tile is
      the one that cannot always: it carries no tone yet, only the promise of
      one, and a tone is a Neural Amp Modeler capture — so it may replace that
      plugin's tone but has nothing to offer any other module. A move drag can
      land on any card but the one it started from. */
  function canDropOnCard(m: RackModule): boolean {
    const drag = rackDrag;
    if (drag?.kind === 'move') return drag.moduleId !== m.id;
    if (drag?.kind !== 'insert') return false;
    return drag.tone3000 ? isNamPlugin(m.name) : true;
  }

  function dropOnModule(m: RackModule) {
    const drag = rackDrag;
    if (drag === null || !canDropOnCard(m)) return;
    endRackDrag();

    if (drag.kind === 'move') {
      // The two trade places; both keep their id, plugin and everything bound
      // to either. One engine operation, not a move each way.
      engine.swapModules(drag.moduleId, m.id);
      return;
    }

    if (drag.tone3000) {
      // Exactly the card's own Browse action: the module stays, its capture
      // changes. Dropping the tile on it is the same sentence said by hand.
      onBrowseTone3000(m.id);
      return;
    }

    const samePlugin = plugins.find((p) => p.id === drag.pluginId)?.name === m.name;
    if (samePlugin && drag.patchId !== undefined) {
      // Nothing about the plugin changes, so nothing needs re-instantiating:
      // this is a patch load, which is instant and keeps the module's id — and
      // with it every MIDI binding and scene value already pointing at it.
      engine.loadPatch(m.id, drag.patchId);
      return;
    }
    editFreshModule(engine.replaceModule(m.id, drag.pluginId, drag.patchId), drag.patchId);
  }

  /** A module dropped from the drawer with no patch behind it arrives with an
      empty knob grid — the plugin is hosted, and nothing on the card says which
      of its parameters matter yet. Mapping them is the only thing left to do,
      so the new module opens straight into its control editor rather than
      waiting to be asked through its own menu. (The engine opens the plugin's
      own editor window on the same condition, for the same reason.)

      A patch is the opposite case: it lands dialled in, named and mapped, and
      is meant to be played. Nothing else switches the mode on either — a rig
      load, a session restore, a moved module all arrive already mapped. */
  function editFreshModule(moduleId: string | null, patchId: string | undefined) {
    if (moduleId && patchId === undefined) knobEditModuleId = moduleId;
  }

  // What follows the pointer is the browser's own drag image, for a drawer tile
  // exactly as for a module being moved. Nothing here draws it.
  //
  // It used to. Chromium renders that snapshot semi-transparent with no opt-out,
  // so drawer drags blanked it and the rack drew a fully opaque stand-in that
  // trailed the pointer, snapped to whatever it was over, and had to be measured
  // so the rings could clear it. All of that was one drag *looking* unlike the
  // other, and every fix it needed was a fix a move never needed. A washed-out
  // snapshot is what this app's drags look like; the two are now the same
  // gesture, described by the same rack, and the tile in hand is drawn by the
  // OS in both.

  // A move can land on any ModuleMoveTarget (including the add-lane spot);
  // an insert only ever sees plain insert targets, because the move-only
  // zones render solely while a move drag is in flight.
  function dropOnTarget(target: ModuleMoveTarget) {
    if (rackDrag?.kind === 'move') engine.moveModule(rackDrag.moduleId, target);
    else if (rackDrag?.kind === 'insert' && rackDrag.tone3000)
      // The TONE3000 tile is dropped like any other, but it has nothing to
      // insert yet: the browser opens and the position is remembered until a
      // tone has actually been downloaded. Dropping is the user saying *where*,
      // which is exactly what dragging a patch means.
      onBrowseTone3000(undefined, target);
    else if (rackDrag?.kind === 'insert')
      editFreshModule(
        engine.insertModule(rackDrag.pluginId, target, rackDrag.patchId),
        rackDrag.patchId,
      );
    endRackDrag();
  }

  // Global edit mode: reveals knob mapping controls and module action buttons
  // on every module card at once. App settings own it so the last selection
  // survives a restart independently of the loaded rig.
  const editMode = $derived(appSettings.editMode);

  // Edit mode unfolds one card at a time (see ModuleCard's `expanded`), and the
  // rack owns which one: a module's own menu switches its control editor on and
  // whichever card had it loses it. Deliberately exclusive — the unfolded card
  // grows by a column and reflows the chain, so several at once would balloon
  // the rack, and mapping knobs is something done to one module at a time
  // anyway. Chosen explicitly rather than by hover, which is what this
  // replaced: a pointer crossing the rack should not put cards into a mode.
  let knobEditModuleId = $state<string | null>(null);

  // The canvas's auto margins centre the chain only while it fits the
  // viewport; once it overflows they collapse to 0, the chain pins to the
  // start edge, and everything the edit toggle adds (insert gaps, wider
  // cards) grows to the right. While the toggle animates the chain's width
  // (240ms gap reveals + 300ms card FLIP), a short rAF loop re-derives
  // scrollLeft from the centre fraction captured before the toggle, so growth
  // splits evenly to both sides.
  //
  // Fraction-based rather than delta-based: each frame recomputes the target
  // from the current scrollWidth, so the fits→overflows handoff is seamless —
  // while the chain fits the target clamps to 0 and the auto margins hold the
  // centre, and the first overflowing frame lands exactly where that centring
  // left off. All three metrics live on the viewport, whose coordinate space
  // the canvas's CSS zoom does not touch, so no zoom conversion is needed.
  let viewportEl: HTMLDivElement | undefined;
  let centreFrame = 0;
  let centreUntil = 0;

  // Covers the reveal and the FLIP with headroom. The FLIP runs regardless of
  // prefersReducedMotion, so no reduced-motion branch: with instant
  // transitions the loop converges on its first frame and idles.
  const CENTRE_HOLD_MS = 450;

  function cancelHoldCentre() {
    if (centreFrame) cancelAnimationFrame(centreFrame);
    centreFrame = 0;
  }

  /** Pin the content point at the viewport's centre through the next
      CENTRE_HOLD_MS of width changes. Call before the state flush that
      resizes the chain, while the old geometry is still measurable. */
  function holdRackCentre() {
    const viewport = viewportEl;
    if (!viewport) return;
    cancelHoldCentre();
    const fraction = (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth;
    centreUntil = performance.now() + CENTRE_HOLD_MS;
    const step = () => {
      centreFrame = performance.now() < centreUntil ? requestAnimationFrame(step) : 0;
      // scrollLeft self-clamps to [0, scrollWidth - clientWidth].
      viewport.scrollLeft = fraction * viewport.scrollWidth - viewport.clientWidth / 2;
    };
    centreFrame = requestAnimationFrame(step);
  }

  function setEditMode(next: boolean) {
    if (next !== editMode) holdRackCentre();
    // Leaving edit mode ends the control editor with it, so re-entering starts
    // on a rack of folded cards rather than reopening whichever one was last
    // being mapped.
    knobEditModuleId = null;
    onSetAppSettings({ editMode: next });
  }

  /** Switch a module's control editor on, or off again if it is the one that
      is on. Unfolding a card widens the chain exactly as the edit toggle does,
      so it holds the rack's centre through the same tween. */
  function toggleKnobEditing(moduleId: string) {
    holdRackCentre();
    knobEditModuleId = knobEditModuleId === moduleId ? null : moduleId;
  }

  /** Keep a module's current knob layout as the template every newly
      downloaded TONE3000 tone starts from — the patch menu's "Set as tone
      template" row, offered on NAM modules only. Meters are dropped: the
      template maps knobs, not displays. Anything the settings normalizer
      would refuse (an over-long layout, a parked far-right cell) is resolved
      by it on the write. */
  function setTone3000Template(module: RackModule) {
    onSetAppSettings({
      tone3000TemplateKnobs: normalizePositions(module.params)
        .filter((k) => !k.isMeter)
        .slice(0, MAX_TEMPLATE_KNOBS)
        .map((k) => ({ paramIndex: k.paramIndex, label: k.label, pos: k.pos })),
    });
  }

  /** The same auto-margin collapse bites on viewport resizes: once the chain
      overflows an axis, shrinking the window crops only the bottom/right
      because the scroll offsets stay put. Record the centre fractions on
      every scroll (user input and the edit-toggle loop alike), and restore
      them whenever the viewport's own size changes, so a resize crops both
      sides of each axis equally. Content-size changes don't resize the
      viewport and are deliberately untouched. */
  function keepCentredOnResize(viewport: HTMLElement) {
    let fracX = 0.5;
    let fracY = 0.5;
    const record = () => {
      fracX = (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth;
      fracY = (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight;
    };
    const restore = () => {
      // Self-clamping; while the chain fits an axis the target is ≤ 0 and the
      // auto margins keep centring, exactly as in holdRackCentre.
      viewport.scrollLeft = fracX * viewport.scrollWidth - viewport.clientWidth / 2;
      viewport.scrollTop = fracY * viewport.scrollHeight - viewport.clientHeight / 2;
    };
    record();
    viewport.addEventListener('scroll', record, { passive: true });
    const observer = new ResizeObserver(restore);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', record);
      observer.disconnect();
    };
  }

  const rackZoom = $derived(appSettings.rackZoom);

  // A route line only paints crisply when it covers a whole number of *physical*
  // pixels, and the rack sits behind two multipliers: the Windows display scale
  // and its own CSS zoom. Track both, and let every route derive its weight and
  // its position from the combined grid instead of hard-coding 2px — which is
  // 2.5 device pixels at 125% scaling, and can never land clean.
  $effect(() => trackDevicePixelRatio());
  const routeScale = $derived(deviceScale(devicePixelRatio(), rackZoom));
  const routeGrid = $derived<RouteGrid>({
    scale: routeScale,
    thickness: snapThickness(ROUTE_THICKNESS, routeScale),
  });

  // Active-rig tracking. The persisted selection (appSettings.activeRigId) is
  // the source of truth, so it survives restarts; user actions assign this
  // writable derived for an instant update and persist the same value through
  // `selectRig`, so the two never diverge. Whether the rack has drifted from
  // the rig is tracked by comparing a signature of the rack against the one
  // snapshotted at load/save/restore time.
  let activeRigId = $derived(appSettings.activeRigId);
  let baseline = $state('');
  // Snapshot the baseline once the engine settles after a whole-rack apply —
  // loadRig and the startup session restore both hold the engine's busy latch
  // while they run. Starts true so the restored session becomes the baseline
  // of the restored rig selection.
  let pendingBaseline = $state(true);

  // Scene *content* edits are part of the rig and count toward its unsaved
  // changes; which scene is active is workspace state (remembered by the
  // engine in app settings) and deliberately not part of the signature.
  // The signature is a normalized projection, not the raw objects: engine-echo
  // fields (knob text, parameter metadata, meter readouts) are excluded and
  // values sit on the scene-epsilon grid, so the engine's asynchronous echoes
  // after a scene switch or rig apply cannot drift the rack away from a
  // baseline that was snapshotted before they arrived.
  const sig = $derived(rigSignature(rack, routing, sceneState.scenes));
  const activeRig = $derived(rigs.find((r) => r.id === activeRigId));
  // No drift is reported while a baseline snapshot is pending: the rack is
  // mid-apply and the signature is transient. Plugin-internal drift (toneDirty)
  // is invisible to the signature, so it is OR'd in; the engine clears it on
  // rig save and load, mirroring the baseline adoption here.
  const dirty = $derived(!!activeRig && !pendingBaseline && (sig !== baseline || toneDirty));

  // A scene switch settles when the engine's echoes have converged onto the
  // scene's stored state; show a spinner on the pressed button until then.
  // The timeout only garbage-collects a switch that never converges (e.g. a
  // scene whose modules are gone).
  let pendingSceneId = $state<string | null>(null);

  // Active-scene drift: compares only what the scene stores (mapped values,
  // bypass, lane state), with an epsilon on values to absorb engine echoes.
  // Mid-switch and mid-apply drift is transient, not a user edit, so it is
  // not reported: while the engine is busy a whole-rack apply is in flight and
  // the fresh scenes have not rejoined the echoed node list yet, and while the
  // baseline is settling the rack still holds placeholder values the echoes
  // have yet to replace.
  const activeScene = $derived(sceneState.scenes.find((s) => s.id === sceneState.activeSceneId));
  const sceneDirty = $derived(
    !!activeScene &&
      pendingSceneId === null &&
      !busy.isBusy &&
      !pendingBaseline &&
      !sceneMatchesLive(activeScene, rack, routing),
  );

  // Scene waiting behind the discard-changes confirmation, if any. Only edit
  // mode raises it; Perform mode stays frictionless for live switching.
  let pendingApplyScene = $state<Scene | null>(null);

  // Insert/delete transition for a module entry (card + its trailing insert
  // gap) and edit-mode gap/split-mode reveals. The entry's width collapses along
  // with one flex gap (the negative margin swallows it), so the neighbours slide
  // closed in the same motion as the
  // fade — width alone would leave a 1rem hole until unmount. `min-width: 0`
  // overrides the flex item's implicit min-content floor, without which the
  // width animation would be clamped and never actually shrink.
  function moduleReveal(node: Element) {
    const width = (node as HTMLElement).offsetWidth;
    return {
      duration: prefersReducedMotion.current ? 0 : 240,
      easing: cubicOut,
      css: (t: number, u: number) =>
        `overflow: hidden; min-width: 0; width: ${t * width}px; margin-right: calc(${u} * (var(--rack-gap) * -1)); opacity: ${t};`,
    };
  }

  function requestSceneSwitch(id: string) {
    const target = sceneState.scenes.find((scene) => scene.id === id);
    if (editMode && sceneDirty && target) {
      pendingApplyScene = target;
      return;
    }

    commitSceneSwitch(id);
  }

  function commitSceneSwitch(id: string) {
    pendingApplyScene = null;
    pendingSceneId = id;
    // Switching scenes is navigation within the rig, not an edit: once the
    // switch settles, the resulting state becomes the new clean baseline.
    pendingBaseline = true;
    engine.applyScene(id);
    setTimeout(() => {
      if (pendingSceneId === id) pendingSceneId = null;
    }, 3000);
  }

  $effect(() => {
    if (
      pendingSceneId !== null &&
      sceneState.activeSceneId === pendingSceneId &&
      (!activeScene || sceneMatchesLive(activeScene, rack, routing))
    ) {
      pendingSceneId = null;
    }
  });

  // How long the signature must hold still before it becomes the baseline.
  // The engine reports "done" before its echoes finish arriving: real param
  // values stream on the native 15 Hz timer (a reloaded rack holds rebuild's
  // placeholders until then), scenes backfill entries on the first value
  // echo, and lane-mix writes ride a 30 ms throttle. Adopting the first
  // eligible signature would freeze those transients into the baseline and
  // read the echoes that follow as user edits. 350 ms spans several ~67 ms
  // echo ticks; the signature excludes meters and echo-only fields, so it
  // does go quiescent and the wait always terminates.
  const BASELINE_SETTLE_MS = 350;

  $effect(() => {
    const settled = sig; // any rack change restarts the settle window
    if (!pendingBaseline || busy.isBusy || pendingSceneId !== null) return;
    const timer = setTimeout(() => {
      baseline = settled;
      pendingBaseline = false;
    }, BASELINE_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  /** Adopt a rig as active and persist the choice for the next launch. */
  function selectRig(id: string) {
    activeRigId = id;
    onSetAppSettings({ activeRigId: id });
  }

  // Both save paths snapshot `sig` before the await: the write is a real disk
  // round-trip, and a knob moved while it is in flight is a new edit, not part
  // of what was written. (Neither ever mutates the rack, so this is exact.) A
  // failed save stays dirty on purpose — the rack really is unsaved, and the
  // persistence notice is what explains why.

  /** Store the rack as a brand-new rig and adopt it. */
  async function saveRig(name: string) {
    const saved = sig;
    const id = await engine.saveRig(name);
    if (id === null) return;
    selectRig(id);
    baseline = saved;
  }

  /** Overwrite the loaded rig. Keyed by id, never by name: two rigs may share
      a display name, and saving one must never write over the other. */
  async function updateActiveRig(rigId: string) {
    const saved = sig;
    if (await engine.updateRig(rigId)) baseline = saved;
  }

  // One Save for every kind of open change: scene drift is captured into the
  // active scene first, so the rig save that follows persists it too
  // (updateScene is synchronous TS-side).
  function saveAll() {
    if (sceneDirty && activeScene) engine.updateScene(activeScene.id);
    if (dirty && activeRig) void updateActiveRig(activeRig.id);
  }

  // Throwing away every open change is destructive, so edit mode confirms it
  // first. Perform mode is intentionally frictionless — like rig and scene
  // switching there, discard acts immediately.
  let confirmingDiscard = $state(false);

  function requestDiscardAll() {
    if (editMode) confirmingDiscard = true;
    else discardAll();
  }

  // Reloading the rig restores scene content along with the chain (scenes are
  // stored inside the rig), so it covers scene drift too — but a full reload
  // tears down and re-instantiates every plugin with the output muted. When
  // the drift is provably confined to what the active scene stores (values,
  // bypass, lane mix, switches) and the scene matches the baseline, re-applying
  // the scene restores the same state gaplessly. toneDirty forces the reload:
  // plugin-internal drift is invisible to both the signature and the scene.
  // With no rig active there is nothing on disk to fall back to but the scene.
  function discardAll() {
    confirmingDiscard = false;
    if (dirty && activeRig) {
      if (!toneDirty && activeScene && canRevertViaScene(baseline, sig, activeScene)) {
        commitSceneSwitch(activeScene.id);
        return;
      }
      void commitLoadRig(activeRig.id);
    } else if (sceneDirty && activeScene) {
      commitSceneSwitch(activeScene.id);
    }
  }

  // Rig waiting behind the discard-changes confirmation, if any.
  let pendingLoadRig = $state<Rig | null>(null);

  function loadRig(id: string) {
    // Loading replaces the whole chain, so anything unsaved is lost: drift on
    // the active rig, or a chain that was never saved to a rig at all. Perform
    // mode is intentionally frictionless: switching rigs there always discards
    // that drift without opening a confirmation dialog.
    if (!editMode) {
      void commitLoadRig(id);
      return;
    }

    const unsaved = dirty || (!activeRig && rack.length > 0);
    const target = rigs.find((r) => r.id === id);
    if (unsaved && target) pendingLoadRig = target;
    else void commitLoadRig(id);
  }

  /** Whether the rig actually loaded — a song recall waits on this before
      applying its scene, since applyScene is refused while the engine is busy. */
  async function commitLoadRig(id: string): Promise<boolean> {
    pendingLoadRig = null;
    const previousRigId = activeRigId;
    const previousBaseline = baseline;
    // Persist the selection first: the engine reads it while applying the rig
    // to bring back the scene last used with it.
    selectRig(id);
    pendingBaseline = true;
    if (await engine.loadRig(id)) return true;
    // The rig never loaded. Put the selection back and measure against the old
    // baseline again, so a rack left half-applied reads as dirty rather than as
    // a clean copy of a rig it isn't. Assigned after the await, so it wins over
    // the pending-baseline effect whichever order the two happen to run in.
    selectRig(previousRigId);
    baseline = previousBaseline;
    pendingBaseline = false;
    return false;
  }

  /** Go to a song: mark it current, load its rig, then land on its scene.
   *
   * Exported because the song panel is unmounted whenever the sidebar is
   * collapsed, so a foot press has to land somewhere permanent — the same
   * reason App owns the metronome's tap history. App routes both the pedal and
   * a tap on a panel row here, so there is exactly one recall path.
   *
   * Lives in Rack because Rack owns the rig-load path: commitLoadRig's
   * selectRig-before-loadRig ordering is what lets the engine bring back the
   * right scene, and it carries the baseline/dirty bookkeeping with it.
   *
   * A missing rig or scene is skipped rather than treated as a failure — one
   * deleted rig must not stop the rest of the song from being recalled. */
  export async function recallSong(song: Song) {
    // The cursor moves first, so the panel highlights where the player is
    // going while the (multi-second) rack rebuild is still running.
    onSetAppSettings({ activeSongId: song.id });

    if (song.rigId !== undefined && song.rigId !== activeRigId) {
      if (!rigs.some((rig) => rig.id === song.rigId)) return;
      // Awaited, not fired alongside the scene: applyScene is refused while the
      // engine is busy, and a rig load holds busy for its whole duration.
      if (!(await commitLoadRig(song.rigId))) return;
    }

    if (song.sceneId !== undefined && sceneState.scenes.some((s) => s.id === song.sceneId))
      requestSceneSwitch(song.sceneId);
  }

  function deleteRig(id: string) {
    engine.deleteRig(id);
    if (id === activeRigId) selectRig('');
  }

  async function newRig() {
    // Drop the old selection before the teardown so nothing shows as active
    // while the chain empties; the auto-save below adopts the new rig.
    selectRig('');
    await engine.newRig();
    // A fresh rig is a real rig from the start: save the empty chain under the
    // first free default name so it's in the list and active immediately.
    await saveRig(nextRigName(rigs.map((r) => r.name)));
  }

  // Performance shortcuts must not act through a modal, a rack rebuild or the
  // standby overlay. Edit mode adds its local guards inside the switcher
  // components.
  const shortcutsEnabled = $derived(
    !busy.isBusy &&
      status.standbyStage === 'active' &&
      !scanDialogOpen &&
      !confirmingDiscard &&
      pendingApplyScene === null &&
      pendingLoadRig === null &&
      !midiLearnActive &&
      contentLearn === null,
  );

  // Middle-button drag pans from anywhere; left-button drag pans only from the
  // rack background. Capture-phase handling keeps a middle-button pan that
  // begins over a knob or slider from also starting that control's gesture.
  let panPointerId = $state<number | null>(null);
  let panX = 0;
  let panY = 0;

  function isRackBackground(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest(
      [
        'button',
        'input',
        'select',
        'textarea',
        'a',
        '[contenteditable="true"]',
        '[draggable="true"]',
        '.module-panel',
        '.mix-strip-anchor',
      ].join(','),
    );
  }

  function startPan(event: PointerEvent) {
    const middleButton = event.button === 1;
    const leftButtonOnBackground =
      event.button === 0 && event.pointerType === 'mouse' && isRackBackground(event.target);
    if (!middleButton && !leftButtonOnBackground) return;

    // preventDefault() below suppresses the compatibility mousedown, and with it
    // the browser's own focus change — so an inline rename input would keep
    // focus and never see the blur that commits it. Move focus out by hand
    // first: clicking the rack background is exactly the "I'm done" gesture.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    event.preventDefault();
    event.stopPropagation();
    panPointerId = event.pointerId;
    panX = event.clientX;
    panY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (event.pointerId !== panPointerId) return;

    cancelHoldCentre();
    event.preventDefault();
    event.stopPropagation();
    const viewport = event.currentTarget as HTMLElement;
    viewport.scrollLeft -= event.clientX - panX;
    viewport.scrollTop -= event.clientY - panY;
    panX = event.clientX;
    panY = event.clientY;
  }

  function endPan(event: PointerEvent) {
    if (event.pointerId !== panPointerId) return;

    event.preventDefault();
    event.stopPropagation();
    const viewport = event.currentTarget as HTMLElement;
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
    panPointerId = null;
  }

  function cancelPan(event: PointerEvent) {
    if (event.pointerId === panPointerId) panPointerId = null;
  }

  function preventMiddleClick(event: MouseEvent) {
    if (event.button === 1) event.preventDefault();
  }

  /** Treat wheel movement over the rack as a horizontal gesture. Keep native
      wheel behaviour for nested menus, whose option lists scroll vertically. */
  function scrollRackHorizontally(event: WheelEvent) {
    if (event.ctrlKey || event.metaKey) return;

    const viewport = event.currentTarget as HTMLElement;
    let target = event.target instanceof HTMLElement ? event.target : null;
    while (target && target !== viewport) {
      const { overflowY } = getComputedStyle(target);
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        target.scrollHeight > target.clientHeight
      )
        return;
      target = target.parentElement;
    }

    // Use the dominant axis so a slightly diagonal trackpad gesture does not
    // become artificially faster (or cancel itself out) after remapping.
    let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
    if (delta === 0) return;

    cancelHoldCentre();
    event.preventDefault();
    viewport.scrollLeft += delta;
  }
</script>

<div class="rack-shell relative h-full min-h-0 overflow-hidden" style:--tools-w="{toolsWidth}px">
  <div
    class="relative flex h-full min-h-0 flex-col overflow-hidden"
    class:pointer-events-none={busy.isBusy}
    aria-busy={busy.isBusy}
    inert={busy.isBusy}
  >
    <TopToolbar
      {rigs}
      {activeRig}
      {dirty}
      canSave={rack.length > 0}
      bind:editMode={() => editMode, setEditMode}
      {shortcutsEnabled}
      onSaveRig={saveRig}
      onSaveAll={saveAll}
      onDiscardAll={requestDiscardAll}
      onLoadRig={loadRig}
      onRenameRig={(id, name) => engine.renameRig(id, name)}
      onDeleteRig={deleteRig}
      onMoveRig={(id, toIndex) => engine.moveRig(id, toIndex)}
      onNewRig={newRig}
      scenes={sceneState.scenes}
      activeSceneId={sceneState.activeSceneId}
      {sceneDirty}
      onSaveScene={(name) => engine.saveScene(name)}
      onApplyScene={requestSceneSwitch}
      onRenameScene={(id, name) => engine.renameScene(id, name)}
      onDeleteScene={(id) => engine.deleteScene(id)}
      onMoveScene={(id, toIndex) => engine.moveScene(id, toIndex)}
      {pendingSceneId}
      {onExportView}
    />

    <!-- Workspace row: the viewport column plus the tools sidebar, side by
         side below the toolbar — the toolbar keeps the full window width, the
         sidebar the row's full height. Also the positioning context for the
         sidebar's maximized stage view, which fills exactly this row. -->
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <!-- The viewport column: the rack above, the module drawer below. The
           drawer lives here rather than under the whole row, so it ends where
           the sidebar starts — the sidebar keeps the full drop to the status
           bar, as the toolbar/status hairlines already imply. -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" bind:clientHeight={workspaceColHeight}>
        <!-- Shrinkable clipper: the viewport's own padding (pt-8 pb-20) is a
             height floor flexbox cannot compress, so a fully-expanded drawer
             would otherwise overflow the column. This wrapper has no padding,
             shrinks to zero, and clips the viewport instead. -->
        <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            bind:this={viewportEl}
            class={[
              'rack-viewport isolate flex min-h-0 min-w-0 flex-1 [scrollbar-width:none] overflow-auto px-6 pt-8 pb-20 lg:px-10 [&::-webkit-scrollbar]:hidden',
              panPointerId !== null && 'panning cursor-grabbing select-none',
            ]}
            {@attach keepCentredOnResize}
            onpointerdowncapture={startPan}
            onpointermovecapture={movePan}
            onpointerupcapture={endPan}
            onpointercancelcapture={endPan}
            onlostpointercapture={cancelPan}
            onauxclick={preventMiddleClick}
            onwheel={scrollRackHorizontally}
          >
            <!-- One module card, wired to the engine — wrapped so a drag can
                 land on the card itself: an insert drag replaces what is
                 there, a move drag trades places with it. The overlay is
                 mounted only while a drag is in flight and sits above the
                 whole card, so the drag never has to thread between the card's
                 own knobs and buttons: one element, one dragenter, one drop. -->
            {#snippet card(m: RackModule)}
              {@const allowed = canDropOnCard(m)}
              {@const over = allowed && cardTargetId === m.id}
              {@const swapping = rackDrag?.kind === 'move'}
              <div
                class="module-slot relative flex flex-none"
                class:module-slot-replacing={over && !swapping}
              >
                {@render moduleCard(m)}
                {#if rackDrag !== null}
                  <div
                    class="replace-zone"
                    class:replace-zone-over={over}
                    class:replace-zone-blocked={!allowed}
                    role="presentation"
                    ondragenter={() => {
                      if (allowed) cardTargetId = m.id;
                    }}
                    ondragleave={() => {
                      if (cardTargetId === m.id) cardTargetId = null;
                    }}
                    ondragover={(e) => {
                      // Without preventDefault the browser refuses the drop and
                      // shows "no entry" — which is exactly right for a tile
                      // this module cannot take.
                      if (allowed) e.preventDefault();
                    }}
                    ondrop={(e) => {
                      e.preventDefault();
                      dropOnModule(m);
                    }}
                  >
                    <span class="replace-badge" aria-hidden="true">
                      {#if swapping}
                        <ArrowsLeftRightIcon size={13} weight="bold" />
                        Swap
                      {:else}
                        <SwapIcon size={13} weight="bold" />
                        Replace
                      {/if}
                    </span>
                  </div>
                {/if}
              </div>
            {/snippet}

            {#snippet moduleCard(m: RackModule)}
              <ModuleCard
                module={m}
                editing={editMode}
                onBypass={(b) => toggleBypass(m, b)}
                bypassPending={bypassPending(m)}
                moduleDragging={draggingModuleId === m.id}
                onModuleDragStart={() => (rackDrag = { kind: 'move', moduleId: m.id })}
                onModuleDragEnd={endRackDrag}
                knobEditing={knobEditModuleId === m.id}
                onToggleKnobEditing={() => toggleKnobEditing(m.id)}
                onParam={(paramIndex, v) => engine.setParam(m.id, paramIndex, v)}
                onAddKnob={(paramIndex, pos) => engine.addKnob(m.id, paramIndex, pos)}
                onRemoveKnob={(knobId) => engine.removeKnob(m.id, knobId)}
                onRemapKnob={(knobId, paramIndex) => engine.remapKnob(m.id, knobId, paramIndex)}
                onMoveKnob={(knobId, pos) => engine.moveKnob(m.id, knobId, pos)}
                onRenameKnob={(knobId, label) => engine.renameKnob(m.id, knobId, label)}
                onSetKnobMeter={(knobId, isMeter) => engine.setKnobMeter(m.id, knobId, isMeter)}
                onSetKnobMeterBipolar={(knobId, bipolar) =>
                  engine.setKnobMeterBipolar(m.id, knobId, bipolar)}
                onRenameModule={(name) => engine.renameModule(m.id, name)}
                onSetStyle={(style) => engine.setModuleStyle(m.id, style)}
                knobMidiLearningId={contentLearn?.kind === 'knob' && contentLearn.moduleId === m.id
                  ? contentLearn.knobId
                  : null}
                moduleMidiLearning={contentLearn?.kind === 'module' &&
                  contentLearn.moduleId === m.id}
                onKnobMidiLearnToggle={(knobId, isBoolean) =>
                  toggleContentLearn({ kind: 'knob', moduleId: m.id, knobId, isBoolean })}
                onKnobMidiClear={(knobId) => engine.setKnobMidi(m.id, knobId, null)}
                onModuleMidiLearnToggle={() =>
                  toggleContentLearn({ kind: 'module', moduleId: m.id })}
                onModuleMidiClear={() => engine.setModuleMidi(m.id, null)}
                patchSections={patchSectionsByPlugin.get(m.name) ?? []}
                onSavePatch={(name) => engine.savePatch(m.id, name)}
                onUpdatePatch={(patchId) => engine.updatePatch(patchId, m.id)}
                onLoadPatch={(patchId) => engine.loadPatch(m.id, patchId)}
                onPreviewPatch={(patchId) => engine.previewPatch(m.id, patchId)}
                onCancelPatchPreview={() => engine.cancelPatchPreview(m.id)}
                onRenamePatch={(patchId, name) => engine.renamePatch(patchId, name)}
                onDeletePatch={(patchId) => engine.deletePatch(patchId)}
                onBrowseTone3000={isNamPlugin(m.name) ? () => onBrowseTone3000(m.id) : undefined}
                onSetTone3000Template={isNamPlugin(m.name) && !m.missing
                  ? () => setTone3000Template(m)
                  : undefined}
                onOpen={() => engine.openEditor(m.id)}
                onRemove={() => engine.removeModule(m.id)}
                onSelectTone3000Model={(modelId) => void engine.tone3000SelectModel(m.id, modelId)}
                onOpenTone={m.tone3000?.url
                  ? () => engine.openExternalUrl(m.tone3000!.url!)
                  : undefined}
              />
            {/snippet}

            <!-- An insertion point: a standing drop target for whatever is dragged
       from the drawer or moved from elsewhere in the chain — at rest it is
       the "+" marker saying "something goes here". `splitAt` is the serial
       module directly after it — the one `createSplit` moves into the first
       lane — so the split button sits exactly where its junction would land.
       It stays mounted (disabled) during drags so the gap's footprint never
       changes mid-drag. `flanks` are the modules on either side of the gap,
       so a moved module's own two gaps render inert instead of posing as
       moves — meaningless for an insert, which lands anywhere. -->
            {#snippet insertGap(
              target: ModuleInsertTarget,
              splitAt?: RackModule,
              flanks?: [RackModule | undefined, RackModule | undefined],
            )}
              {#if editMode}
                <div class="flex flex-none items-center gap-[.4rem]" transition:moduleReveal>
                  {@render dropZone(
                    target,
                    rackDrag?.kind === 'move' &&
                      (draggingModuleId === flanks?.[0]?.id ||
                        draggingModuleId === flanks?.[1]?.id),
                  )}
                  {#if splitAt}
                    <!-- Invisible, not dimmed, while a drag is in flight: a ghosted
                     button beside the landing spot reads as part of the drop
                     UI. visibility keeps its footprint so the gap stays put.
                     z-10 lifts it over the signal route, which would otherwise
                     draw straight through the button face. -->
                    <IconButton
                      variant="canvas"
                      label="Split into parallel lanes here"
                      class={['relative z-10', rackDrag !== null && 'invisible']}
                      disabled={rackDrag !== null}
                      onclick={() => engine.createSplit(splitAt.id)}
                    >
                      <ArrowsSplitIcon class="-rotate-90" size={15} weight="bold" />
                    </IconButton>
                  {/if}
                </div>
              {/if}
            {/snippet}

            <!-- One insert gap's drop target. Mounted in edit mode whether or not a
       drag is in flight — the "+" ring only *paints* while one is, so the
       gap's footprint never changes and a drag start never reflows the rack.
       Inert zones (a moved module's own gaps) keep the geometry stable but
       are unpainted and do not accept the drop — without preventDefault the
       browser shows no-drop. Handlers no-op with no drag in flight, so a
       stray OS file drag can't land here. -->
            {#snippet dropZone(target: ModuleMoveTarget, inert: boolean)}
              {@const key = targetKey(target)}
              <div
                class="module-drop-zone"
                class:drop-zone-idle={rackDrag === null}
                class:drop-zone-inert={inert}
                class:drop-zone-over={!inert && dragOverTargetKey === key}
                role="presentation"
                ondragenter={() => {
                  if (!inert && rackDrag !== null) dragOverTargetKey = key;
                }}
                ondragleave={() => {
                  if (dragOverTargetKey === key) dragOverTargetKey = null;
                }}
                ondragover={(e) => {
                  if (!inert && rackDrag !== null) e.preventDefault();
                }}
                ondrop={(e) => {
                  e.preventDefault();
                  if (!inert) dropOnTarget(target);
                }}
              >
                <!-- The mark inside the ring is the whole message: a plus for
                     something arriving, the move arrows for a module changing
                     seats. No pill and no word — a gap is 2.25rem of glass and
                     a label beside it would be bigger than the target it names.
                     Cards are the other way round (see .replace-badge): there
                     the ring is a whole module wide, and what needs saying is
                     which of two things the drop does to the module already
                     sitting in it. -->
                <span
                  class="drop-zone-plus"
                  class:drop-zone-plus-turns={rackDrag?.kind !== 'move'}
                  class:drop-zone-plus-flips={rackDrag?.kind === 'move'}
                  aria-hidden="true"
                >
                  {#if rackDrag?.kind === 'move'}
                    <ArrowsLeftRightIcon size={14} weight="bold" />
                  {:else}
                    <PlusIcon size={14} weight="bold" />
                  {/if}
                </span>
              </div>
            {/snippet}

            <!-- A horizontal run of cards with an insertion point after every module.
       Card + trailing insert gap share one wrapper so an inserted or deleted
       module transitions as a single footprint (see moduleReveal); the wrapper
       reproduces the row's own gap so the layout is unchanged at rest. -->
            {#snippet cardRow(segment: RackModule[], startPosition: number, nextGroupId?: string)}
              {#each segment as m, i (moduleRenderKey(segment, m, i))}
                <div class="flex flex-none items-center gap-(--rack-gap)" transition:moduleReveal>
                  {@render card(m)}
                  {@render insertGap(
                    {
                      serialPosition: startPosition + i + 1,
                      beforeGroupId: i === segment.length - 1 ? nextGroupId : undefined,
                    },
                    segment[i + 1],
                    [m, segment[i + 1]],
                  )}
                </div>
              {/each}
            {/snippet}

            <!-- Lane modules preserve their own order independently of the flat rack.
       Nested splits aren't supported, so lane gaps never offer one. -->
            {#snippet laneCardRow(laneId: string, segment: RackModule[])}
              {@render insertGap({ laneId, beforeModuleId: segment[0]?.id }, undefined, [
                undefined,
                segment[0],
              ])}
              {#each segment as m, i (moduleRenderKey(segment, m, i))}
                <div class="flex flex-none items-center gap-(--rack-gap)" transition:moduleReveal>
                  {@render card(m)}
                  {@render insertGap({ laneId, beforeModuleId: segment[i + 1]?.id }, undefined, [
                    m,
                    segment[i + 1],
                  ])}
                </div>
              {/each}
            {/snippet}

            <!-- Scrolling/padding live outside the route canvas so 50% means the same
       signal centre for the serial line, module cards, and split mask. -->
            <div
              class={['rack-canvas m-auto pt-4 pb-12', rackIsEmpty && 'w-full']}
              style:zoom={rackZoom}
            >
              <div
                class="rack-flow"
                class:rack-flow-empty={rackIsEmpty}
                style:--route-thickness="{routeGrid.thickness}px"
                style:--route-trunk-top={trunkTop(flow, routeGrid)}
                style:--trunk-mask={trunkMask}
                {@attach measureFlow}
              >
                <div
                  class="relative z-2 flex-none bg-space px-[.65rem] py-[.35rem] font-mono text-xs font-bold tracking-[1.5px] whitespace-nowrap text-muted"
                >
                  IN
                </div>

                {#if rackIsEmpty}
                  {#if starterInstalling}
                    <!-- A first run, with the starter bundle downloading. It
                         takes minutes, nobody asked for it, and the drawer is
                         near enough empty until it lands — so the empty rack
                         says what is happening rather than offering a drag
                         there is nothing to drag. Not dismissible and offering
                         no action: it ends by itself, and the Packages panel
                         is where the per-plugin progress already lives.
                         Deliberately does not name the pedals: the bundle's
                         contents are the catalogue's to change without a
                         release. -->
                    <section
                      class="relative z-2 mx-auto flex max-w-[27rem] min-w-[22rem] flex-[1_1_24rem] flex-col items-center rounded-lg border border-[color-mix(in_srgb,var(--color-ink)_14%,transparent)] bg-menu px-7 pt-6 pb-[1.4rem] text-center shadow-[0_12px_32px_color-mix(in_srgb,var(--color-void)_55%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_4%,transparent)]"
                      aria-labelledby="empty-rack-title"
                      aria-busy="true"
                    >
                      <h2
                        class="m-0 text-base font-semibold tracking-[-.01em] text-ink"
                        id="empty-rack-title"
                      >
                        Installing starter plugins…
                      </h2>
                      <p class="mt-[.35rem] mb-0 max-w-[22rem] text-xs leading-[1.5] text-muted">
                        A starter set of pedals is downloading. They appear in the drawer as they
                        land — the Packages panel has the details.
                      </p>
                    </section>
                  {:else if plugins.length > 0}
                    {@const emptyTarget = { serialPosition: 0 }}
                    {@const emptyKey = targetKey(emptyTarget)}
                    <!-- The empty rack is one drop target and says so once: the
                       panel itself carries the dashed accent outline every
                       insert gap uses, so the mark and the words inside it only
                       have to name the gesture. It used to carry a ring of its
                       own inside a card-styled panel, with a title above a
                       sentence — three statements of the same thing, none of
                       them the outline that actually marks a target.
                       Opaque, so the trunk reads as entering and leaving it. -->
                    <!-- The same in perform mode as in edit: an empty rack has
                         one thing to say either way, and a card that named the
                         mode ("Add modules") only made the user answer a
                         question about Plectrify before answering one about
                         their rig. -->
                    <!-- Clickable as well as droppable, because "drag something
                         here" leaves open where from. A press raises the drawer
                         and flashes its TONE3000 tile: the drawer is the answer,
                         and the tile is the one offer that needs nothing already
                         installed or saved. Deliberately not the browser itself
                         — the click explains where modules come from, and
                         choosing one stays the user's move. In perform mode
                         that means turning edit mode on first: the drawer is
                         only mounted there, and a reveal held for a drawer that
                         never appears goes stale (see reveal.ts). -->
                    <button
                      type="button"
                      class="empty-drop-zone relative z-2 mx-auto max-w-[27rem] min-w-[22rem] flex-[1_1_24rem] cursor-pointer"
                      class:drop-zone-over={dragOverTargetKey === emptyKey}
                      onclick={() => {
                        setEditMode(true);
                        revealBrowseInDrawer();
                      }}
                      ondragenter={() => {
                        if (rackDrag !== null) dragOverTargetKey = emptyKey;
                      }}
                      ondragleave={() => {
                        if (dragOverTargetKey === emptyKey) dragOverTargetKey = null;
                      }}
                      ondragover={(e) => {
                        if (rackDrag !== null) e.preventDefault();
                      }}
                      ondrop={(e) => {
                        e.preventDefault();
                        dropOnTarget(emptyTarget);
                      }}
                    >
                      <!-- Unchanged under a drag but for the outline firming up
                           (see .empty-drop-zone.drop-zone-over): a hovered gap
                           elsewhere in the chain does not restate what is
                           arriving either — that is the drag image's job. -->
                      <span class="empty-drop-content">
                        <PlusIcon size={16} weight="bold" />
                        Drag a patch or plugin here
                      </span>
                    </button>
                  {:else}
                    <section
                      class="relative z-2 mx-auto flex max-w-[27rem] min-w-[22rem] flex-[1_1_24rem] flex-col items-center rounded-lg border border-[color-mix(in_srgb,var(--color-ink)_14%,transparent)] bg-menu px-7 pt-6 pb-[1.4rem] text-center shadow-[0_12px_32px_color-mix(in_srgb,var(--color-void)_55%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_4%,transparent)]"
                      aria-labelledby="empty-rack-title"
                    >
                      <h2
                        class="m-0 text-base font-semibold tracking-[-.01em] text-ink"
                        id="empty-rack-title"
                      >
                        No modules yet
                      </h2>
                      <p class="mt-[.35rem] mb-4 max-w-[22rem] text-xs leading-[1.5] text-muted">
                        Add an amp, effect, or utility to the signal chain.
                      </p>
                      <div class="flex flex-col items-center gap-2">
                        <!-- With nothing scanned yet the drawer has nothing to
                         offer, so "drag one here" would name something the user
                         does not have. This card is that case alone, and the way
                         in is the scan itself. -->
                        <Button size="sm" class={promptButtonClass} onclick={scanPlugins}>
                          Scan for plugins
                        </Button>
                        <span
                          class="text-[.65rem] text-[color-mix(in_srgb,var(--color-muted)_78%,transparent)]"
                          >No VST3 plugins found</span
                        >
                        <!-- With no plugins at all, scanning finds nothing and the
                         rack is a dead end. This is the way out: the Packages
                         panel can fetch a working starter set.

                         Entirely optional, and dismissible: someone who intends
                         to use their own plugins should be able to say so once
                         and not be asked again. Dismissing hides the suggestion
                         only — the Packages panel stays in the rail. -->
                        {#if !appSettings.catalogueHintDismissed}
                          <div class="flex items-center gap-2">
                            <button
                              class="cursor-pointer border-0 bg-transparent p-0 text-[.7rem] text-accent underline underline-offset-2 hover:opacity-80"
                              onclick={() => onSetAppSettings({ activeTool: 'plugins' })}
                            >
                              Get starter plugins
                            </button>
                            <button
                              class="cursor-pointer border-0 bg-transparent p-0 text-[.7rem] text-muted hover:opacity-80"
                              title="Hide this suggestion. The Packages panel stays in the sidebar."
                              onclick={() => onSetAppSettings({ catalogueHintDismissed: true })}
                            >
                              No thanks
                            </button>
                          </div>
                        {/if}
                      </div>
                    </section>
                  {/if}
                {:else}
                  {@render insertGap(
                    {
                      serialPosition: 0,
                      beforeGroupId: groups[0]?.position === 0 ? groups[0].id : undefined,
                    },
                    headSegment[0],
                    [undefined, headSegment[0]],
                  )}
                {/if}

                <!-- Serial modules before the split (or the whole chain when unsplit). -->
                {@render cardRow(headSegment, 0, groups[0]?.id)}

                {#each groups as group, gi (group.id)}
                  {@const geometry = routeGeometries[group.id]}
                  {@const tailSegment = serial.slice(
                    group.position,
                    groups[gi + 1]?.position ?? serial.length,
                  )}

                  <!-- Split → parallel lanes → merge. The lanes fan out from one split
           junction and sum back at the merge junction. -->
                  <div class="split-block shrink-0">
                    <!-- Ahead of the lanes in the DOM, and below them in the stacking order,
             so the active route wins where the two deliberately lap. -->
                    {#if editMode && geometry}
                      <div
                        class="split-stem"
                        aria-hidden="true"
                        style:--action-stem-height={actionStemHeight(geometry, routeGrid)}
                        style:--action-stem-width={actionStemWidth(geometry, routeGrid)}
                      ></div>
                    {/if}

                    {#if editMode}
                      <div class="absolute top-[-2.5rem] left-8 z-46" transition:moduleReveal>
                        <SplitModeToggle
                          mode={splitMode(group)}
                          pending={splitModePending(group)}
                          onSelect={(mode) => setSplitMode(group, mode)}
                        />
                      </div>
                    {/if}

                    <div
                      class="split-routes"
                      class:split-routes-editing={editMode}
                      {@attach measureRoutes(group.id)}
                    >
                      {#if geometry}
                        <!-- No viewBox: user units are then local CSS pixels 1:1, so the
                 snapped path coordinates reach the screen unscaled. A viewBox
                 would re-derive that scale from a measured height and drift the
                 lower lanes by whatever the two disagreed about. -->
                        <svg class="route-fan route-fan-in" aria-hidden="true">
                          {#each fanOrder(group) as { lane, index } (lane.id || index)}
                            <path
                              class:route-inactive={!laneIsAudible(group.id, lane.id)}
                              d={splitPath(
                                geometry,
                                geometry.laneCenters[index] ?? geometry.center,
                                routeGrid,
                              )}
                            ></path>
                          {/each}
                        </svg>
                        <svg class="route-fan route-fan-out" aria-hidden="true">
                          {#each fanOrder(group) as { lane, index } (lane.id || index)}
                            <path
                              class:route-inactive={!laneIsAudible(group.id, lane.id)}
                              d={mergePath(
                                geometry,
                                geometry.laneCenters[index] ?? geometry.center,
                                routeGrid,
                              )}
                            ></path>
                          {/each}
                        </svg>
                      {/if}

                      <!-- The index fallback keeps legacy/corrupt persisted routing data
               from crashing Svelte when an old lane has no id. Live lanes
               still retain their stable engine id as the primary key. -->
                      {#each group.lanes as lane, li (lane.id || li)}
                        <div class="lane-track">
                          <div class="lane-connector lane-connector-in" aria-hidden="true"></div>

                          <div
                            class="lane-row"
                            class:route-inactive={!laneIsAudible(group.id, lane.id)}
                            style:--lane-line-top={laneLineTop(geometry, li)}
                          >
                            {#if editMode}
                              <MixStrip
                                {lane}
                                editing={editMode}
                                selecting={!!group.activeLaneId}
                                selected={group.activeLaneId === lane.id}
                                audible={laneIsAudible(group.id, lane.id)}
                                pending={laneSwitchPending(group, lane.id)}
                                onSelect={() => requestLaneSwitch(group, lane.id)}
                                onMix={(mix) => engine.setLaneMix(lane.id, mix)}
                                onRename={(name) => engine.renameLane(lane.id, name)}
                                canMoveUp={li > 0}
                                canMoveDown={li < group.lanes.length - 1}
                                onMoveUp={() => engine.moveLane(lane.id, li - 1)}
                                onMoveDown={() => engine.moveLane(lane.id, li + 1)}
                                onRemove={() => engine.removeLane(lane.id)}
                                midiLearning={contentLearn?.kind === 'lane' &&
                                  contentLearn.laneId === lane.id}
                                onMidiLearnToggle={() =>
                                  toggleContentLearn({ kind: 'lane', laneId: lane.id })}
                                onMidiClear={() => engine.setLaneMidi(lane.id, null)}
                              />
                            {:else if group.activeLaneId}
                              <LaneSwitchButton
                                label={lane.name}
                                active={group.activeLaneId === lane.id}
                                pending={laneSwitchPending(group, lane.id)}
                                onSelect={() => requestLaneSwitch(group, lane.id)}
                              />
                            {/if}
                            {@render laneCardRow(lane.id, laneModules(lane.id))}
                          </div>

                          <div class="lane-connector lane-connector-out" aria-hidden="true"></div>
                        </div>
                      {/each}
                    </div>

                    {#if editMode}
                      <div class="absolute bottom-[-2.75rem] left-8 z-2 flex gap-[.4rem]">
                        {#if draggingModuleId}
                          <!-- Dropping here moves the module into a brand-new lane of this
                   group, in one step — no module is created, so this stays the
                   drag-and-drop counterpart of "Add lane". Move drags only:
                   `newLaneForGroupId` is a move target, so an insert drag sees
                   the plain (disabled) button instead. -->
                          {@render dropZone({ newLaneForGroupId: group.id }, false)}
                        {:else}
                          <!-- Routing only: the lane arrives empty and is filled through its
                   own insertion points, like every other spot in the chain. -->
                          <IconButton
                            variant="canvas"
                            label="Add lane"
                            disabled={rackDrag !== null}
                            onclick={() => engine.addLane(group.id)}
                          >
                            <PlusIcon size={15} weight="bold" />
                          </IconButton>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  {@render insertGap(
                    {
                      serialPosition: group.position,
                      beforeGroupId:
                        groups[gi + 1]?.position === group.position ? groups[gi + 1].id : undefined,
                    },
                    tailSegment[0],
                    [undefined, tailSegment[0]],
                  )}
                  {@render cardRow(tailSegment, group.position, groups[gi + 1]?.id)}
                {/each}

                <div
                  class="relative z-2 flex-none bg-space px-[.65rem] py-[.35rem] font-mono text-xs font-bold tracking-[1.5px] whitespace-nowrap text-muted"
                >
                  OUT
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- The module drawer: everything a module can be made from, dragged
             onto the insert points above. A flex sibling below the viewport,
             never an overlay — opening it pushes the rack shorter instead of
             covering modules, the same rule the tool sidebar follows. Inside
             the busy-inert column, so it locks with the rest of the rack
             while the engine works. -->
        {#if editMode}
          <!-- mx keeps the sheet's rounded corners off the hard viewport
               edges, so the frame reads as a border rather than a clip. -->
          <div
            class="relative mx-1.5 min-h-0 flex-none"
            transition:slide={{
              duration: prefersReducedMotion.current ? 0 : 200,
              easing: cubicOut,
            }}
          >
            <ModuleDrawer
              {patches}
              {plugins}
              {catalogue}
              {pluginScan}
              blacklisted={blacklistedPlugins}
              height={appSettings.drawerHeight}
              onSetHeight={(px) => onSetAppSettings({ drawerHeight: px })}
              collapsed={appSettings.drawerCollapsed}
              onSetCollapsed={(c) => onSetAppSettings({ drawerCollapsed: c })}
              openSection={appSettings.drawerOpenSection}
              onSetOpenSection={(key) => onSetAppSettings({ drawerOpenSection: key })}
              maxHeight={drawerMaxHeight}
              lowered={insertDrawerSunk}
              onDragStart={startInsertDrag}
              onDragEnd={endRackDrag}
              onRenamePatch={(patchId, name) => engine.renamePatch(patchId, name)}
              patchOrder={appSettings.drawerPatchOrder}
              onReorderPatches={(sectionKey, patchIds) =>
                onSetAppSettings({
                  drawerPatchOrder: { ...appSettings.drawerPatchOrder, [sectionKey]: patchIds },
                })}
              onSetPatchCategory={(patchId, category) => engine.setPatchCategory(patchId, category)}
              onDeletePatch={(patchId) => engine.deletePatch(patchId)}
              onScan={scanPlugins}
              onManageBlacklist={() => (blacklistOpen = true)}
              onBrowseTone3000={() => onBrowseTone3000()}
              namPluginId={plugins.find((p) => isNamPlugin(p.name))?.id}
              {missingCaptures}
              {onRepairPatch}
              onOpenToneUrl={(url) => engine.openExternalUrl(url)}
              onShowPackage={(packageId) => {
                // Both halves, in this order: the panel is only mounted while
                // Packages is the active tool, so the request is held by
                // reveal.ts until it subscribes on mount.
                onSetAppSettings({ activeTool: 'plugins' });
                revealPackageInPanel(packageId);
              }}
            />

            <!-- The one destructive drop, and the whole drawer is it: while a
                 module is airborne the drawer is covered edge to edge and
                 washed red, and letting go anywhere on it removes the module.
                 The wash is the whole message — a mark and a word in the middle
                 of it only invited the drag to aim at them, when what the zone
                 wants is any point at all. A pill floating over the rack asked
                 the drag to
                 find a small target; the drawer is where a module came from,
                 it is already the largest thing on screen that is not the
                 rack, and it has nothing else to offer a module in hand — its
                 own tiles are drag *sources*. So the overlay covers it whole
                 rather than sitting inside it, which also keeps the drawer
                 itself ignorant of the rack's drag state: one element, one
                 dragenter, one drop, in the component that owns that state. -->
            {#if draggingModuleId}
              <div
                class="drawer-remove-drop rounded-t-xl"
                class:drop-zone-over={dragOverTargetKey === DELETE_TARGET_KEY}
                role="presentation"
                transition:fade={{ duration: prefersReducedMotion.current ? 0 : 120 }}
                ondragenter={() => (dragOverTargetKey = DELETE_TARGET_KEY)}
                ondragleave={() => {
                  if (dragOverTargetKey === DELETE_TARGET_KEY) dragOverTargetKey = null;
                }}
                ondragover={(e) => e.preventDefault()}
                ondrop={(e) => {
                  e.preventDefault();
                  if (rackDrag?.kind === 'move') engine.removeModule(rackDrag.moduleId);
                  endRackDrag();
                }}
              ></div>
            {/if}
          </div>
        {/if}
      </div>
      <!-- Measured, not derived: the rail is a fixed token but the panel's
           width is per-tool and it animates open and shut, so the busy scrim
           can only keep clear of the sidebar by asking how wide it is now.
           The left hairline lives here, not on the panel inside: the wrapper
           spans the whole workspace row, so the one vertical line runs
           unbroken from the toolbar's lower border to the status bar's upper
           border, straight through the drawer's own top hairline. -->
      <div
        class="flex min-h-0 flex-none border-l border-(--edge-hair)"
        bind:clientWidth={toolsWidth}
      >
        {@render toolsSidebar?.()}
      </div>
    </div>

    {#if status.midiTunerActive}
      <LiveTunerOverlay
        reading={status.tunerReading}
        settings={appSettings}
        reduceMotion={prefersReducedMotion.current}
        onClose={() => engine.setStatus({ midiTunerActive: false })}
      />
    {/if}
  </div>

  {#if busy.isBusy && !toolStaged}
    <!-- The scrim starts below the toolbar: mid-load the rig/scene switchers
       are exactly what the user is watching, so they stay visible (though
       inert, like everything else while the engine is busy). With a tool
       staged there is no dialog at all — the stage view fills the row the
       scrim would cover, and it must stay readable through a rig switch. -->
    <TaskDialog
      overlayClass="dialog-below-toolbar"
      title={busy.loading?.pluginName ? `Loading ${busy.loading.pluginName}` : 'Preparing rack'}
      description="Restoring your saved signal chain and plugin settings."
      statusText={busy.loading && busy.loading.total > 0
        ? `Plugin ${Math.max(1, busy.loading.current)} of ${busy.loading.total}`
        : 'Restoring your previous session'}
      progress={busy.loading && busy.loading.total > 0 ? loadingPercent : undefined}
    />
  {/if}

  {#if scanDialogOpen}
    <TaskDialog
      state={pluginScan.status === 'complete' ? 'complete' : 'working'}
      title={pluginScan.status === 'complete' ? 'Scan complete' : 'Scanning VST3 plugins'}
      description={pluginScan.status === 'complete'
        ? `${pluginScan.pluginCount} ${pluginScan.pluginCount === 1 ? 'plugin is' : 'plugins are'} ready to use.`
        : 'Checking the system plugin folders. Some plugins may take a moment to load.'}
      statusText={pluginScan.status === 'complete' ? undefined : 'Scan in progress'}
      closeLabel="Close scan results"
      onClose={() => (scanDialogOpen = false)}
    />
  {/if}

  {#if blacklistOpen}
    <BlacklistDialog
      entries={blacklistedPlugins}
      scanning={pluginScan.status === 'scanning'}
      onRetry={retryBlacklisted}
      onClose={() => (blacklistOpen = false)}
    />
  {/if}

  {#if confirmingDiscard}
    <ConfirmDialog
      title="Discard changes?"
      description={activeRig
        ? `“${activeRig.name}” goes back to the last saved version. Unsaved changes are lost.`
        : 'The active scene goes back to the last saved version. Unsaved changes are lost.'}
      confirmLabel="Discard"
      overlayClass="dialog-below-toolbar"
      onConfirm={discardAll}
      onCancel={() => (confirmingDiscard = false)}
    />
  {/if}

  {#if pendingLoadRig}
    <ConfirmDialog
      title={`Load “${pendingLoadRig.name}”?`}
      description={activeRig
        ? `“${activeRig.name}” has unsaved changes that will be lost.`
        : 'The current chain is not saved to a rig and will be lost.'}
      confirmLabel="Discard & load"
      overlayClass="dialog-below-toolbar"
      onConfirm={() => void commitLoadRig(pendingLoadRig!.id)}
      onCancel={() => (pendingLoadRig = null)}
    />
  {/if}

  {#if pendingApplyScene}
    <ConfirmDialog
      title={`Switch to “${pendingApplyScene.name}”?`}
      description={activeScene
        ? `“${activeScene.name}” has unsaved changes that will be lost.`
        : 'The active scene has unsaved changes that will be lost.'}
      confirmLabel="Discard & switch"
      overlayClass="dialog-below-toolbar"
      onConfirm={() => commitSceneSwitch(pendingApplyScene!.id)}
      onCancel={() => (pendingApplyScene = null)}
    />
  {/if}
</div>

<style>
  /* Holds a dialog's full-shell scrim off the chrome frame, so a rig load or
     its discard prompt veils the rack and nothing else. The top offset matches
     the toolbar height set in TopToolbar.svelte times the chrome scale zooming
     it; the right offset is the measured tool sidebar, which is where the
     player is looking — a song recall is *started* from that panel, and
     covering it hides the very list showing what is coming next, along with
     the entry the prompt is asking about. The selector outweighs the shell's
     own inset-0. */
  .rack-shell :global(.dialog-below-toolbar) {
    top: calc(3.9rem * var(--ui-scale, 1));
    right: var(--tools-w, 0px);
  }

  .rack-viewport.panning :global(*) {
    cursor: grabbing !important;
  }
  /* Centre the rig on whichever axis it fits, and pin it to the start edge on
     the axis it overflows. Auto margins do both: they collapse to 0 once free
     space goes negative, unlike align-/justify-content centring, which would
     push the start of the chain outside the scrollable range. */
  .rack-flow {
    --route-color: var(--color-accent);
    --route-glow-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
    /* One radius for every route. `box-shadow` and `drop-shadow` share the same
       blur convention, so the CSS lines and the SVG fans previously spreading
       the same colour over 9px and 4px made the fans read as the brighter of
       the two where they meet — the halo differed, not the line. */
    --route-glow-blur: 9px;
    /* A muted route is dimmed by colour, never by `opacity`. Routes overlap in
       several places — the two fans meet at a lane's line, and the add-lane stem
       laps over the last lane on purpose — and translucent strokes visibly
       double up wherever they do. Mixing toward the page they sit on looks the
       same on screen without the seams. */
    --route-muted-color: color-mix(in srgb, var(--color-accent) 22%, var(--color-space));
    --route-muted-glow-color: color-mix(in srgb, var(--color-accent) 7%, transparent);
    /* One spacing for the whole chain — the serial row, the lane rows, and
       the module-entry wrappers reproduce it, and moduleReveal collapses it. */
    --rack-gap: 1.5rem;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--rack-gap);
    width: max-content;
  }

  /* `top` is measured and snapped rather than a bare 50%: centring a line on a
     box of arbitrary height lands it mid-pixel as often as not, and the fans
     that meet it at either end of a split are snapped to the same grid. The
     fallback only covers the frame before the first measurement. */
  .rack-flow::before {
    content: '';
    position: absolute;
    z-index: 0;
    left: 2rem;
    right: 2rem;
    top: var(--route-trunk-top, calc(50% - var(--route-thickness) / 2));
    height: var(--route-thickness);
    background: var(--route-color);
    box-shadow: 0 0 var(--route-glow-blur) var(--route-glow-color);
    /* Measured in the script: one transparent stop per split group, cutting the
       trunk out where that group's lanes take over. */
    mask-image: var(--trunk-mask, none);
    pointer-events: none;
  }
  .rack-flow-empty {
    width: 100%;
  }
  .split-block {
    position: relative;
    z-index: 2;
  }
  /* Each lane occupies one grid row. The measured SVG fans in the outer
     columns connect the main route to the exact centre of every row. */
  .split-routes {
    --lane-gap: 1.5rem;
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 2rem max-content 2rem;
    grid-auto-flow: row;
    row-gap: var(--lane-gap);
    align-items: stretch;
  }
  /* Edit mode docks a hovered card's toolbars just outside its top and bottom
     edges, so stacked lanes need room for one of them between rows. */
  .split-routes-editing {
    --lane-gap: 3.5rem;
  }
  .split-routes:has(:global(.mix-strip-anchor:hover)),
  .split-routes:has(:global(.mix-strip-anchor:focus-within)),
  .split-routes:has(:global(.module-panel.module-editing:hover)),
  .split-routes:has(:global(.module-panel.module-editing:focus-within)) {
    z-index: 40;
  }
  .lane-track {
    display: contents;
  }
  .lane-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--rack-gap);
    isolation: isolate;
  }
  .lane-row:has(:global(.mix-strip-anchor:hover)),
  .lane-row:has(:global(.mix-strip-anchor:focus-within)),
  .lane-row:has(:global(.module-panel.module-editing:hover)),
  .lane-row:has(:global(.module-panel.module-editing:focus-within)) {
    z-index: 30;
  }
  .lane-row::before {
    content: '';
    position: absolute;
    top: var(--lane-line-top, calc(50% - var(--route-thickness) / 2));
    height: var(--route-thickness);
    background: var(--route-color);
    box-shadow: 0 0 var(--route-glow-blur) var(--route-glow-color);
    pointer-events: none;
    transition:
      background 0.2s ease,
      box-shadow 0.2s ease;
  }
  .lane-row::before {
    z-index: -1;
    inset-inline: 0;
  }
  .lane-connector {
    position: relative;
    min-width: 2rem;
  }
  /* Sized explicitly rather than stretched by top/bottom: an <svg> is a replaced
     element, so an auto height resolves to its own intrinsic size instead of
     filling the gap. */
  .route-fan {
    position: absolute;
    z-index: 2;
    top: 0;
    bottom: 0;
    width: 2rem;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .route-fan-in {
    left: 0;
  }
  .route-fan-out {
    right: 0;
  }
  /* No `vector-effect: non-scaling-stroke`: with the viewBox gone, user units
     already are local CSS pixels, and pinning the stroke to unscaled pixels
     would leave the fans thinner than the trunk at any zoom above 100%. */
  .route-fan path {
    fill: none;
    stroke: var(--route-color);
    stroke-width: var(--route-thickness);
    /* Butt, not round: an arm ends exactly on the lane row's edge, so half a
       stroke of round cap lapped over whatever sits there — the switch button's
       border on the way in, the last card's on the way out. A round cap was
       only ever hiding a seam, and both sides of the join now land on the same
       device pixel. Joins stay round for the elbows. */
    stroke-linecap: butt;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 var(--route-glow-blur) var(--route-glow-color));
    transition:
      stroke 0.2s ease,
      filter 0.2s ease;
  }
  .lane-row.route-inactive::before {
    background: var(--route-muted-color);
    box-shadow: 0 0 var(--route-glow-blur) var(--route-muted-glow-color);
  }
  .route-fan path.route-inactive {
    stroke: var(--route-muted-color);
    filter: drop-shadow(0 0 var(--route-glow-blur) var(--route-muted-glow-color));
  }
  /* An insert gap's standing drop target. Mounted whenever edit mode is on,
     but *painted* only while a drag is in flight (`.drop-zone-idle` hides the
     ring and the "+") — one 2.25rem round footprint in every state, so a drag
     start never reflows the rack. The padding/negative-margin pair grows the
     hit area — which the CSS zoom on .rack-canvas scales along with
     everything else — at zero layout cost. The ring is drawn by ::before over
     the content box only. */
  .module-drop-zone {
    position: relative;
    z-index: 5;
    flex: 0 0 2.25rem;
    width: 2.25rem;
    height: 2.25rem;
    box-sizing: content-box;
    padding: 1.25rem 0.625rem;
    margin: -1.25rem -0.625rem;
  }
  .module-drop-zone::before {
    content: '';
    position: absolute;
    inset: 1.25rem 0.625rem;
    border-radius: 999px;
    border: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease,
      opacity 0.15s ease,
      border-radius 0.15s ease;
  }
  /* While a drag is live the ring sits directly on the accent route line,
     where a translucent accent wash all but disappears — so it gets a solid
     menu backing (the split button's treatment) and a brighter dash. */
  .module-drop-zone:not(.drop-zone-idle)::before {
    border-color: color-mix(in srgb, var(--color-accent) 75%, transparent);
    background: color-mix(in srgb, var(--color-accent) 12%, var(--color-menu));
  }
  /* One hover state, whatever is in hand. A move and an insert ask the gap the
     same question — "does it go here?" — so it answers them the same way: the
     ring firms up and softens from a circle into a rounded square while the
     "+" turns a quarter with it, both over the same 0.15s, because they are
     halves of one gesture. A quarter turn lands the "+" back on itself, so the
     mark is unchanged and only the motion reads. */
  .module-drop-zone.drop-zone-over::before {
    border-style: solid;
    border-radius: 0.6rem;
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 22%, var(--color-menu));
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 25%, transparent);
  }
  /* Unpainted in two cases: no drag in flight, and a zone this drag cannot
     land on (a moved module's own two gaps, where the drop would be a no-op).
     A ghosted ring offered nothing but a target to try and be refused by, so
     an invalid gap simply is not there to the eye. It stays *mounted* either
     way — that is what keeps the gap's footprint constant, so neither the
     start of a drag nor the pointer crossing a gap reflows the chain. */
  .module-drop-zone.drop-zone-idle::before,
  .module-drop-zone.drop-zone-idle .drop-zone-plus,
  .module-drop-zone.drop-zone-inert::before,
  .module-drop-zone.drop-zone-inert .drop-zone-plus {
    opacity: 0;
  }
  /* The at-rest marker inside the ring. Its own layer over ::before, centred
     on the content box; pointer-events stay on the zone itself. */
  .drop-zone-plus {
    position: absolute;
    inset: 1.25rem 0.625rem;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--color-accent) 70%, var(--color-muted));
    opacity: 0.7;
    pointer-events: none;
    transition:
      opacity 0.15s ease,
      rotate 0.15s ease,
      scale 0.15s ease,
      color 0.15s ease;
  }
  .module-drop-zone.drop-zone-over .drop-zone-plus {
    opacity: 1;
    color: var(--color-accent);
  }
  /* The quarter turn belongs to the plus alone, and that is the point of it: a
     plus is symmetrical, so a quarter turn lands the mark back on itself and
     only the motion reads — the ring's own softening from circle to rounded
     square, given a second voice. The move arrows are not symmetrical; turning
     them would leave them pointing the wrong way, saying "up and down" about a
     chain that runs left to right. They get a mirror instead: negative scale on
     x alone flips them left-to-right through their own vertical axis, which is
     the same symmetry the quarter turn exploits — the mark lands back on itself
     and only the motion reads — while every arrowhead stays on the horizontal,
     still describing a chain that runs sideways. */
  .module-drop-zone.drop-zone-over .drop-zone-plus-turns {
    rotate: 90deg;
  }
  .module-drop-zone.drop-zone-over .drop-zone-plus-flips {
    scale: -1 1;
  }

  /* Dropping onto a card rather than into a gap — a tile (the module becomes
     what was dropped) or another module (the two trade places). The zone
     covers the whole card and is mounted only while a drag is in flight, so
     exactly one element sees the drag — the card's own knobs, menus and docks
     can neither swallow the drop nor fire a dragleave as the pointer crosses
     them.

     It speaks the gaps' language (dashed accent at rest, solid and lit where
     the drop would land) plus the one thing a gap never has to say: something
     already here is answering for it. Hence the veil — without it a ring
     around a card reads as "add inside", which is not a thing the rack can
     do. Only a *replace* also greys the card beneath (see
     `.module-slot-replacing`): that module is on its way out, where a swapped
     one is only changing seats. */
  .replace-zone {
    position: absolute;
    inset: 0;
    /* Above the card's own hover lift (z-index 50 on .module-editing:hover),
       which a drag started elsewhere can leave latched. */
    z-index: 60;
    border-radius: 1rem; /* the card's own rounded-2xl */
    border: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;
  }
  .replace-zone.replace-zone-over {
    border-style: solid;
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-void) 62%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent),
      0 0 18px color-mix(in srgb, var(--color-accent) 28%, transparent);
  }
  /* A drop this module cannot take (the TONE3000 tile over anything but a NAM
     module; a move drag over its own card). Left mounted and made transparent
     to the drag rather than removed, so the pointer falls through to a card
     with no drop handler and the browser draws its own "no" — the same answer,
     without a ring that would have promised otherwise. Falling through matters
     doubly for a move drag: the gaps beneath the module's own card stay
     reachable, exactly as they were before a card was a drop target at all. */
  .replace-zone.replace-zone-blocked {
    opacity: 0;
    pointer-events: none;
  }
  /* The card recedes under the veil: this is the module on its way out. */
  .module-slot-replacing :global(.module-panel) {
    filter: grayscale(0.6) brightness(0.75);
  }
  .module-slot :global(.module-panel) {
    transition: filter 0.15s ease;
  }
  /* What the drop would do, in a word — Replace or Swap, since a card is the
     one target where the same gesture has two possible meanings and the module
     underneath has to be told which. A gap needs no such pill: its mark already
     says everything (see .drop-zone-plus), and a label beside 2.25rem of glass
     would be bigger than the target it names.

     Straddling the card's top edge rather than centred in it: the drag image is
     drawn on the pointer, which is somewhere in the middle of the card the
     whole time it is hovered, and a short card has no middle to spare. The drag
     image says what is arriving; this says which module is making way. */
  .replace-badge {
    position: absolute;
    top: 0;
    left: 50%;
    translate: -50% -50%;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    /* Never the event target: a child under the pointer fires the zone's own
       dragleave, which would flicker the ring off the moment it appeared. */
    pointer-events: none;
    padding: 0.22rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 20%, var(--color-menu));
    color: var(--color-accent);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    /* Only the hovered target names the gesture; every other one is a ring and
       nothing more, or the rack fills with the same word repeated. */
    opacity: 0;
    scale: 0.9;
    transition:
      opacity 0.15s ease,
      scale 0.15s ease;
  }
  .replace-zone-over .replace-badge {
    opacity: 1;
    scale: 1;
  }

  /* The empty rack is an insert gap the width of the chain, and it is drawn as
     one: the dashed accent outline, the accent wash and the solid-on-hover
     firming are .module-drop-zone's, at panel scale. Opaque, so it masks the
     trunk and the route reads as entering and leaving it. */
  .empty-drop-zone {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: 5.5rem;
    padding: 1.1rem 1.35rem;
    border-radius: 0.75rem;
    border: 1px dashed color-mix(in srgb, var(--color-accent) 55%, transparent);
    background: color-mix(in srgb, var(--color-accent) 7%, var(--color-panel-solid));
    transition:
      border-color 0.15s ease,
      border-style 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;
  }
  /* Inert to the pointer, exactly as .drop-zone-plus is in an insert gap: the
     zone is the drop target, and a child that can receive dragenter/dragleave
     of its own tears a hole in it — crossing onto the mark or the words fires
     the zone's dragleave and the outline drops out, leaving only the panel's
     padding highlighting. */
  .empty-drop-content {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--color-accent) 70%, var(--color-muted));
    pointer-events: none;
    transition: color 0.15s ease;
  }
  /* It is a button too (a press raises the drawer), so it answers the pointer —
     softly, and short of the drop state: hovering it is not the same event as a
     tile being held over it. */
  .empty-drop-zone:hover {
    border-color: color-mix(in srgb, var(--color-accent) 75%, transparent);
    background: color-mix(in srgb, var(--color-accent) 11%, var(--color-panel-solid));
  }
  .empty-drop-zone:hover .empty-drop-content {
    color: color-mix(in srgb, var(--color-accent) 88%, var(--color-muted));
  }
  .empty-drop-zone.drop-zone-over {
    border-style: solid;
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel-solid));
    box-shadow: 0 0 14px color-mix(in srgb, var(--color-accent) 25%, transparent);
  }
  .empty-drop-zone.drop-zone-over .empty-drop-content {
    color: var(--color-accent);
  }

  /* The drawer turned into the one destructive drop: it speaks in the danger
     colour at every step, dashed while the module is merely airborne, solid
     once a release would actually land. The wash is a translucent tint rather
     than a coat of paint: the drawer's own tiles stay legible underneath, so
     it reads as the drawer in a state rather than as a red panel that has
     replaced it. */
  .drawer-remove-drop {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed color-mix(in srgb, var(--color-danger) 55%, transparent);
    border-bottom: 0;
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }
  .drawer-remove-drop.drop-zone-over {
    border-style: solid;
    border-color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 22%, transparent);
    box-shadow: inset 0 0 32px color-mix(in srgb, var(--color-danger) 25%, transparent);
  }
  /* Continue the split trunk to the prospective next lane, stopping short of
     the Add lane control instead of drawing a route through the edit actions.
     Its own element rather than a pseudo on `.split-actions`, because it has to
     paint *under* `.split-routes` (z 1) while those controls stay above it.

     The width is measured, not fixed: it is what puts this box's left border on
     the fan's riser, which a fixed 1.25rem misses by about a pixel. `left` then
     follows from it, keeping the right edge on the same `2rem` column the fan
     and `.split-actions` are anchored to. */
  .split-stem {
    position: absolute;
    bottom: -1.75rem;
    left: calc(2rem - var(--action-stem-width, 1.25rem));
    width: var(--action-stem-width, 1.25rem);
    height: var(--action-stem-height, calc(3.15rem + 3px));
    border-left: var(--route-thickness) solid var(--route-muted-color);
    border-bottom: var(--route-thickness) solid var(--route-muted-color);
    border-bottom-left-radius: 10px;
    box-shadow: -3px 3px 7px var(--route-muted-glow-color);
    pointer-events: none;
  }
</style>
