<script lang="ts">
  import PartnershipSplash from './features/tone3000/PartnershipSplash.svelte';
  import Tone3000InstallStatus from './features/tone3000/Tone3000InstallStatus.svelte';
  import { isNamPlugin, type Tone3000State } from './lib/engine/tone3000';
  import type { ModuleMoveTarget } from './lib/engine/EngineBridge';
  import { onMount } from 'svelte';
  import { MockEngine } from './lib/engine/MockEngine';
  import { JuceEngine, juceAvailable } from './lib/engine/JuceEngine';
  import { DEFAULT_APP_SETTINGS } from './lib/engine/appSettings';
  import { applyTheme, bootTheme } from './lib/theme';
  import type { EngineBridge, PluginScanState } from './lib/engine/EngineBridge';
  import {
    DEFAULT_APP_INFO,
    DEFAULT_STATUS_STATE,
    STANDALONE_CAPABILITIES,
  } from './lib/engine/types';
  import type {
    AppInfo,
    AppSettings,
    BlacklistedPlugin,
    EngineBusyState,
    Patch,
    PluginInfo,
    Rig,
    RackModule,
    RoutingState,
    SceneState,
    StatusState,
    ToolId,
  } from './lib/engine/types';
  import { EMPTY_CATALOGUE_STATE, type CatalogueState } from './lib/engine/catalogue';
  import type { BrowserFacts } from './features/info/browserFacts';
  import { buildDiagnostics, type DiagReport } from './features/info/diagnostics';
  import { UI_BUILD_STAMP, UI_COMMIT } from './lib/buildStamp';
  import UpdateNotice from './features/info/UpdateNotice.svelte';
  import { revealPatchInDrawer } from './features/drawer/reveal';
  import { registerTap } from './features/metronome/tapTempo';
  import { MAX_BPM, MIN_BPM } from './features/metronome/metronomeBeat';
  import Rack from './features/rack/Rack.svelte';
  import SetupWizard from './features/setup/SetupWizard.svelte';
  import ToolSidebar from './features/sidebar/ToolSidebar.svelte';
  import PersistenceNotice from './features/status/PersistenceNotice.svelte';
  import StandbyOverlay from './features/status/StandbyOverlay.svelte';
  import StatusBar from './features/status/StatusBar.svelte';
  import WindowResizeHandles from './features/window/WindowResizeHandles.svelte';
  import TooltipLayer from './lib/components/TooltipLayer.svelte';
  import { exportCurrentView } from './lib/exportView';

  // Real JUCE engine when hosted in the app; MockEngine in a plain browser.
  const nativeHost = juceAvailable();
  const engine: EngineBridge = nativeHost ? new JuceEngine() : new MockEngine();

  let rack = $state<RackModule[]>([]);
  let patches = $state<Patch[]>([]);
  // The TONE3000 session, and which module (if any) the browser was opened
  // for. `undefined` vs a module id is the whole difference between "replace
  // this module's tone" and "make me a patch in the drawer".
  let tone3000 = $state<Tone3000State>({
    connected: false,
    pending: false,
    apiAccess: 'none',
    splashSeen: false,
    downloads: [],
  });
  /** The partnership splash, shown once ever before the first trip to
      TONE3000. The only thing that now stands between the button and their
      site, and it earns that: it is where the user learns whose service this
      is and agrees to go there. */
  let splashOpen = $state(false);
  /** Which patches name a TONE3000 capture that is not on disk. Asked of the
      engine rather than inferred: only it can see the download folder. Quiet
      by design — a rig recalled on a fresh machine shows a chip and a
      re-download button, it does not stop the show. */
  let missingCaptures = $state<ReadonlySet<string>>(new Set());
  let tone3000ModuleId = $state<string | undefined>(undefined);
  /** Where a tile dropped on the rack asked for its module. Held until a tone
      has actually been downloaded — dragging says *where*, browsing says
      *what*, and the module cannot exist until both are answered. */
  let tone3000InsertAt = $state<ModuleMoveTarget | undefined>(undefined);
  let rigs = $state<Rig[]>([]);
  let plugins = $state<PluginInfo[]>([]);
  let routing = $state<RoutingState>({ groups: [] });
  let busy = $state<EngineBusyState>({ isBusy: true });
  let status = $state<StatusState>({ ...DEFAULT_STATUS_STATE });
  // Theme is seeded from the boot mirror rather than the plain defaults:
  // subscribeAppSettings emits synchronously with the defaults before the
  // engine's stored copy has been read, and a dark default here would flash
  // over the page index.html already painted light.
  let appSettings = $state<AppSettings>({ ...DEFAULT_APP_SETTINGS, theme: bootTheme() });
  let sceneState = $state<SceneState>({ scenes: [], activeSceneId: null });
  // Plugin-internal drift: a plugin changed its own state (native editor edit,
  // program switch) â€” invisible to the rack signature but part of a rig save.
  let toneDirty = $state(false);
  // Host version, plugin-scan state and the scanner's blacklist are owned here
  // because the Info panel's diagnostics report needs all three; the rack's
  // scan/blacklist dialogs read the latter two as props.
  let appInfo = $state<AppInfo>({ ...DEFAULT_APP_INFO });
  // Absence means standalone (which has everything): the field postdates the
  // engines that lacked it, so the page never flashes a degraded layout
  // before the push lands.
  const caps = $derived(appInfo.capabilities ?? STANDALONE_CAPABILITIES);
  let pluginScan = $state<PluginScanState>({ status: 'idle', pluginCount: 0 });
  let blacklistedPlugins = $state<BlacklistedPlugin[]>([]);
  // The catalogue is owned here for the rack's module drawer, which files
  // patches under their package's category. The Packages panel keeps its own
  // subscription — subscribeCatalogue replays the last known state, so two
  // subscribers cost nothing.
  let catalogue = $state<CatalogueState>(EMPTY_CATALOGUE_STATE);
  // True only during a fresh installation's automatic starter-bundle download.
  // The engine starts that run itself, so the empty rack is the only place the
  // first few minutes are accounted for.
  let starterInstalling = $state(false);
  // True while the tuner's MIDI learn (in the status bar's slideout) is armed.
  // Owned here because two siblings need it: the status bar arms it, and the
  // rack pauses live MIDI dispatch while it is armed â€” and disarms it when
  // the MIDI settings dialog opens (one armed learn app-wide).
  let tunerMidiLearning = $state(false);
  // Same shape for the mute's learn, armed from the mute pill's own slideout.
  let muteMidiLearning = $state(false);
  // Same shape for the looper's main-switch learn (in the tools sidebar). The
  // rack sees these as one combined midiLearnActive flag below.
  let looperMidiLearning = $state(false);
  let metronomeMidiLearning = $state(false);
  let setlistMidiLearning = $state(false);
  // Kept above the panel because a MIDI tap must still work while it is closed.
  let metronomeTaps = $state<number[]>([]);
  // And for the MIDI settings view's armed learn (also in the sidebar).
  let settingsMidiLearning = $state(false);
  // The tool staged across the full workspace, or null. Session-only (like
  // the stage tuner): raised by a panel's maximize button or by a looper
  // action arriving from a MIDI pedal â€” a foot on the looper switch means
  // the player's eyes are about to look for the looper's state.
  let stagedTool = $state<ToolId | null>(null);
  // Mirror in the other direction: true while the rack has a knob/module/lane
  // learn armed, so the tuner's Learn button refuses to arm a second one.
  let rackMidiLearning = $state(false);
  // For rack.disarmContentLearn() â€” the one disarm that flows downward.
  let rackComponent = $state<ReturnType<typeof Rack>>();
  /** True once the engine's stored preferences have actually been read. The
      first-run wizard hangs off `setupCompleted`, whose *default* claims this
      machine is new — so acting before this would greet every existing user
      with a welcome screen for half a second. */
  let settingsLoaded = $state(false);
  /** The wizard reopened deliberately from Settings, as opposed to owed. */
  let setupReopened = $state(false);
  // Gated on the capability: in a DAW the host owns the audio device, so the
  // first-run audio wizard must never appear.
  const setupOpen = $derived(
    caps.audioDevices &&
      (setupReopened || (settingsLoaded && !appSettings.setupCompleted && !splashOpen)),
  );
  /** Finished or waved away — the same write either way. A player who dismissed
      it must not be asked again on every launch, and Settings keeps the way
      back. */
  function closeSetup() {
    setupReopened = false;
    if (!appSettings.setupCompleted) engine.setAppSettings({ setupCompleted: true });
  }
  function handleMetronomeTap() {
    const result = registerTap(metronomeTaps, performance.now());
    metronomeTaps = result.taps;
    if (result.bpm === null) return;
    engine.setStatus({ metronomeBpm: result.bpm });
    engine.metronomeCommand('sync');
  }
  /** MIDI tempo nudge — the pedal equivalent of the panel's − / + buttons. */
  function nudgeMetronomeBpm(step: number) {
    const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, status.metronomeBpm + step));
    engine.setStatus({ metronomeBpm: bpm });
  }
  // Re-checked whenever the patch list or the download folder changes — a
  // patch can arrive from a rig, an import or a fresh install, and the answer
  // is only ever true of a moment.
  $effect(() => {
    void patches;
    void tone3000.downloads;
    let cancelled = false;
    void engine.tone3000Verify().then((missing) => {
      if (!cancelled) missingCaptures = missing;
    });
    return () => {
      cancelled = true;
    };
  });
  /** Neural Amp Modeler, matched by the plugin's own name — the same key a
      patch is matched by. It ships with Plectrify and is scanned from inside the
      installation, so it is normally there; `undefined` means the scan has not
      run yet (or someone has taken the app apart), and the browse simply opens
      without a module to land on. */
  const namPlugin = $derived(plugins.find((p) => isNamPlugin(p.name)));

  /**
   * Go to TONE3000. There is no in-app browser to open: this hands the whole
   * thing to the engine, which shows TONE3000's own pages in their own window
   * — reopened on the page, the size and the monitor it was left on — and
   * turns whatever the user picks there into a patch.
   *
   * Two things can come first, and only ever once each: the partnership splash
   * (the first time, ever) and installing Neural Amp Modeler (if it is not
   * there). Both resume into the same call rather than making the user click
   * Browse again.
   */
  function browseTone3000(moduleId?: string, insertAt?: ModuleMoveTarget) {
    tone3000ModuleId = moduleId;
    tone3000InsertAt = insertAt;

    if (!tone3000.splashSeen) {
      splashOpen = true;
      return;
    }

    openTone3000();
  }

  /** The trip itself, past the splash. Separate from `browseTone3000` because
      the splash's Continue has to go straight here: it has just told the engine
      the splash was seen, and that answer arrives on the next state push —
      re-asking `tone3000.splashSeen` in between would show the splash again. */
  function openTone3000() {
    engine.tone3000Browse({
      moduleId: tone3000ModuleId,
      // Ships with Plectrify, so this is all but always there; if a scan has not
      // finished yet the engine falls back to its own lookup by name.
      pluginId: namPlugin?.id,
      // A2 explicitly, and not omitted: TONE3000 reads a missing architecture
      // as its legacy A1 + Custom selection and hides every modern capture.
      architecture: '2',
    });
  }

  // onMount rather than $effect: the engine is created once for the app's
  // lifetime, so there is nothing to react to, and onMount tracks nothing —
  // the returned unsubscribe is the teardown.
  // One mount, one teardown: every subscription is registered together and
  // every unsubscribe is returned as a single function.
  onMount(() => {
    const unsubscribes = [
      engine.subscribeRack((r) => (rack = r)),
      engine.subscribeScenes((s) => (sceneState = s)),
      engine.subscribePatches((a) => (patches = a)),
      engine.subscribeTone3000((t) => (tone3000 = t)),
      engine.subscribeRigs((r) => (rigs = r)),
      engine.subscribePlugins((p) => (plugins = p)),
      engine.subscribeRouting((r) => (routing = r)),
      engine.subscribeBusy((state) => (busy = state)),
      engine.subscribeToneDirty((d) => (toneDirty = d)),
      engine.subscribeStatus((state) => (status = state)),
      engine.subscribeAppSettings((settings) => (appSettings = settings)),
      engine.subscribeBlacklistedPlugins((entries) => (blacklistedPlugins = entries)),
      engine.subscribeAppInfo((info) => (appInfo = info)),
      engine.subscribePluginScan((state) => (pluginScan = state)),
      engine.subscribeCatalogue((state) => (catalogue = state)),
      engine.subscribeStarterInstall((running) => (starterInstalling = running)),
      // A tone dropped onto the rack becomes a module only once it has been
      // downloaded and turned into a patch — the engine reports the patch id,
      // and the position the drop chose is still waiting here. The callback
      // reads `tone3000InsertAt` and `namPlugin` when it fires, not when it is
      // registered, so nothing here needs to be reactive.
      engine.subscribeTone3000Install((event) => {
        if (event.stage !== 'done' || !event.patchId) return;
        const target = tone3000InsertAt;
        tone3000InsertAt = undefined;
        if (target && namPlugin) engine.insertModule(namPlugin.id, target, event.patchId);
        // Wherever it was headed, a downloaded tone is also a new patch, and
        // "it is in the drawer" is only true once the drawer has shown it:
        // the same arrival a package install gets, down to turning edit mode
        // on so there is a drawer to arrive in (see reveal.ts).
        engine.setAppSettings({ editMode: true });
        revealPatchInDrawer(event.patchId);
      }),
    ];
    // The first-run wizard's gate: the defaults say "never set up", which is
    // true of a fresh machine and a lie everywhere else, so nothing may act on
    // them until the stored file has answered.
    void engine.settingsReady().then(() => (settingsLoaded = true));
    // Resolve the catalogue once at boot: nothing else requests it until the
    // Packages panel opens, and without it every patch in the drawer files
    // under "Uncategorised". Offline this falls back to the verified cache,
    // and failing that degrades to cosmetic grouping only.
    void engine.refreshCatalogue();
    return () => unsubscribes.forEach((off) => off());
  });
  /** The Info panel's diagnostics report, built from the live state above.
      Plugin and audio-device identities are in (they are what breaks); nothing
      the user typed is â€” no rig, scene, lane or module names â€” because the
      report is written to be pasted into a public issue. See diagnostics.ts.
      The panel supplies the browser facts it measured once at mount, so the
      15 Hz status stream doesn't re-measure the DOM. */
  function getReport(browser: BrowserFacts): DiagReport {
    return buildDiagnostics({
      info: appInfo,
      status,
      rack,
      routing,
      scan: pluginScan,
      plugins,
      blacklisted: blacklistedPlugins,
      busy,
      settings: appSettings,
      browser,
      ui: { buildStamp: UI_BUILD_STAMP, commit: UI_COMMIT },
      library: { rigs: rigs.length, scenes: sceneState.scenes.length },
    });
  }

  /** Open the sidebar's Info panel â€” the home of the diagnostics report and
      the issue links. Un-stages first so the panel is actually visible rather
      than hidden behind a staged tool. */
  function openInfoPanel() {
    stagedTool = null;
    engine.setAppSettings({ activeTool: 'info' });
  }

  // index.html's boot script paints the mirrored theme before the first frame;
  // this keeps <html> in step once the engine's stored value lands and on every
  // later change. <html> rather than the app's own root div because <body>
  // paints the page and the resize handles and tooltips render outside it.
  $effect(() => applyTheme(appSettings.theme));

  // Auto Standby's activity ping. The engine can only see the guitar input, so
  // silent interaction â€” editing a rig, reading the manual with the window
  // focused â€” has to be reported from here or standby would engage mid-session.
  // Throttled hard: this fires on raw pointer/key/wheel traffic, and the engine
  // only needs to know the user is present, not how busy they are.
  const ACTIVITY_PING_MS = 5000;
  let lastActivityPing = 0;
  function pingStandbyActivity() {
    // While asleep every interaction must get through: the throttle is there to
    // spare the bridge, not to delay a wake the user is asking for.
    const asleep = status.standbyStage !== 'active';
    const now = performance.now();
    if (!asleep && now - lastActivityPing < ACTIVITY_PING_MS) return;
    lastActivityPing = now;
    engine.standbyCommand('activity');
  }

  function handleGlobalKeyDown(e: KeyboardEvent) {
    // Keep Chromium/WebView2 page zoom separate from the rack's own zoom.
    // Account for both main-keyboard and numpad representations.
    const modifier = e.ctrlKey || e.metaKey;
    const zoomKey = ['+', '-', '=', '_', '0'].includes(e.key);
    if (modifier && !e.altKey && zoomKey) e.preventDefault();
  }

  function preventBrowserZoomWheel(e: WheelEvent) {
    // Trackpad pinch is exposed by Chromium as a Ctrl+wheel gesture.
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }

  function preventHostedContextMenu(e: MouseEvent) {
    // Keep browser inspection available during standalone MockEngine
    // development, but hide WebView2's native menu in the shipped host.
    if (nativeHost) e.preventDefault();
  }
</script>

<svelte:window
  onkeydown={handleGlobalKeyDown}
  onwheelcapture={preventBrowserZoomWheel}
  oncontextmenu={preventHostedContextMenu}
  onpointerdowncapture={pingStandbyActivity}
  onkeydowncapture={pingStandbyActivity}
  onwheel={pingStandbyActivity}
/>

<!-- Owned here (state, learn bindings) but rendered inside the rack shell,
     beside the viewport and *below* the toolbar â€” the toolbar keeps the full
     window width. Still a flex sibling of the viewport, never an overlay:
     expanding pushes the rack narrower instead of covering modules. -->
{#snippet toolsSidebar()}
  <ToolSidebar
    {engine}
    {status}
    {appSettings}
    onSetAppSettings={(settings) => engine.setAppSettings(settings)}
    {appInfo}
    capabilities={caps}
    {getReport}
    bind:looperMidiLearning
    bind:metronomeMidiLearning
    bind:setlistMidiLearning
    bind:settingsMidiLearning
    otherLearnActive={rackMidiLearning || tunerMidiLearning || muteMidiLearning}
    onMidiSettingsOpen={() => {
      // One armed learn app-wide: the MIDI view brings its own Learn buttons,
      // so a learn still listening elsewhere would capture the same press.
      tunerMidiLearning = false;
      muteMidiLearning = false;
      looperMidiLearning = false;
      metronomeMidiLearning = false;
      setlistMidiLearning = false;
      rackComponent?.disarmContentLearn();
    }}
    onMetronomeTap={handleMetronomeTap}
    {rigs}
    {sceneState}
    {busy}
    onRecallSong={(song) => rackComponent?.recallSong(song)}
    onOpenSetup={() => (setupReopened = true)}
    bind:stagedTool
  />
{/snippet}

<!-- --ui-scale drives the CSS zoom each chrome piece (toolbar, sidebar,
     status bar) applies to its own root â€” one setting, three consumers.
     Set here rather than on <html> because everything it governs lives in
     this layout column. -->
<div class="flex h-screen min-h-0 flex-col overflow-hidden" style:--ui-scale={appSettings.uiScale}>
  <main class="relative min-h-0 flex-1 overflow-hidden">
    <Rack
      bind:this={rackComponent}
      {toolsSidebar}
      onLooperMidiAction={() => (stagedTool = 'looper')}
      onToolMaximizeMidiAction={(tool) => (stagedTool = stagedTool === tool ? null : tool)}
      onMetronomeMidiAction={(action) => {
        if (action === 'tap') handleMetronomeTap();
        else if (action === 'tempoUp') nudgeMetronomeBpm(1);
        else if (action === 'tempoDown') nudgeMetronomeBpm(-1);
        stagedTool = 'metronome';
      }}
      onSetlistMidiAction={() => (stagedTool = 'setlist')}
      toolStaged={stagedTool !== null}
      {engine}
      {rack}
      {routing}
      {patches}
      {rigs}
      {plugins}
      {catalogue}
      {starterInstalling}
      {busy}
      {status}
      {appSettings}
      {sceneState}
      onExportView={import.meta.env.DEV ? exportCurrentView : undefined}
      {toneDirty}
      {pluginScan}
      {blacklistedPlugins}
      onBrowseTone3000={browseTone3000}
      {missingCaptures}
      onRepairPatch={(patchId) => void engine.tone3000Repair(patchId)}
      onSetAppSettings={(settings) => engine.setAppSettings(settings)}
      midiLearnActive={tunerMidiLearning ||
        muteMidiLearning ||
        looperMidiLearning ||
        metronomeMidiLearning ||
        setlistMidiLearning ||
        settingsMidiLearning}
      bind:rackMidiLearning
    />

    {#if splashOpen}
      <!-- The one thing between the button and TONE3000's own site, and only
           ever the first time: whose service this is, and an explicit "take me
           there". Dismissing it cancels the trip; continuing resumes exactly
           the browse that was asked for, module and drop position intact. -->
      <div class="absolute inset-0 z-40 flex items-stretch bg-void/60 backdrop-blur-[2px]">
        <div
          class="m-auto max-w-[min(34rem,94%)] overflow-hidden rounded-xl border border-ink/15 bg-panel shadow-2xl"
        >
          <PartnershipSplash
            onContinue={() => {
              splashOpen = false;
              engine.tone3000SplashSeen();
              openTone3000();
            }}
            onCancel={() => (splashOpen = false)}
          />
        </div>
      </div>
    {/if}
  </main>
  <StatusBar
    {engine}
    {status}
    onSetStatus={(next) => engine.setStatus(next)}
    {appSettings}
    onSetAppSettings={(settings) => engine.setAppSettings(settings)}
    otherLearnActive={rackMidiLearning ||
      looperMidiLearning ||
      metronomeMidiLearning ||
      setlistMidiLearning ||
      settingsMidiLearning}
    bind:tunerMidiLearning
    bind:muteMidiLearning
  />
</div>

<!-- App level, over everything, and the first thing a fresh installation shows:
     the audio device is what stands between installing Plectrify and hearing a
     guitar, and it is the one part of the rig the app cannot choose entirely
     on its own. Shown once ever — finished or skipped settles it. -->
{#if setupOpen}
  <SetupWizard {engine} {status} {appInfo} {starterInstalling} onDone={closeSetup} />
{/if}

<StandbyOverlay {status} onWake={() => engine.standbyCommand('wake')} onReport={openInfoPanel} />

<!-- App level, and the only trace TONE3000 leaves inside Plectrify while a tone is
     on its way: the picking happened in TONE3000's own window, which has
     already closed by the time this appears. -->
<Tone3000InstallStatus {engine} />

<!-- App level: every writer goes through the same engine, so one notice covers
     rigs, patches, settings and the session autosave alike. -->
<PersistenceNotice {status} onReport={openInfoPanel} />

<!-- App level rather than inside the rack: checking for a newer Plectrify is a
     start-up concern of the whole app, and it belongs beside the other things
     that float over everything. -->
<UpdateNotice
  {engine}
  dismissedVersion={appSettings.updateDismissedVersion}
  onDismiss={(version) => engine.setAppSettings({ updateDismissedVersion: version })}
/>

<!-- Also capability-gated: the DAW owns the plugin window's frame. -->
{#if nativeHost && caps.windowChrome}
  <WindowResizeHandles {engine} />
{/if}

<TooltipLayer />
