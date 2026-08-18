<script lang="ts">
  import { ArrowClockwiseIcon, CaretRightIcon, CornersOutIcon, XIcon } from 'phosphor-svelte';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type {
    AppInfo,
    AppSettings,
    EngineBusyState,
    HostCapabilities,
    MidiActionId,
    Rig,
    SceneState,
    Song,
    StatusState,
    ToolId,
  } from '../../lib/engine/types';
  import type { BrowserFacts } from '../info/browserFacts';
  import type { DiagReport } from '../info/diagnostics';
  import InfoPanel from '../info/InfoPanel.svelte';
  import LooperTool from '../looper/LooperTool.svelte';
  import MetronomeTool from '../metronome/MetronomeTool.svelte';
  import PluginsPanel from '../plugins/PluginsPanel.svelte';
  import { refreshPhase, requestRefresh } from '../plugins/refreshState.svelte';
  import SetlistTool from '../setlist/SetlistTool.svelte';
  import SettingsPanel from '../settings/SettingsPanel.svelte';
  import { TOOLS, UTILITY_TOOLS, type ToolDef } from './tools';
  import IconButton from '../../lib/components/IconButton.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import type { MidiLearnApi } from '../../lib/components/MidiLearn.svelte';
  import { learnRingClass, learnStateOf } from '../../lib/components/learnSkin';

  interface Props {
    engine: EngineBridge;
    status: StatusState;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Host version and build, for the Info panel. */
    appInfo: AppInfo;
    /** Which host-owned facilities exist, for the Settings panel's gates —
        already defaulted by App, so this is never absent here. */
    capabilities: HostCapabilities;
    /** Builds the Info panel's diagnostics report from App's live state; the
        panel supplies the browser facts it measured once at mount. */
    getReport: (browser: BrowserFacts) => DiagReport;
    /** True while the looper's MIDI learn is armed — see LooperTool. */
    looperMidiLearning?: boolean;
    /** True while either metronome MIDI target is learning. */
    metronomeMidiLearning?: boolean;
    /** True while one of the song transport's MIDI targets is learning. */
    setlistMidiLearning?: boolean;
    /** Same shape for the MIDI settings view's armed learn. */
    settingsMidiLearning?: boolean;
    /** True while a MIDI learn outside the sidebar (tuner, rack) is armed. */
    otherLearnActive?: boolean;
    /** Fired when the MIDI settings view opens, so App can disarm every learn
        armed elsewhere — one armed learn app-wide, and the view brings its own
        Learn buttons. */
    onMidiSettingsOpen: () => void;
    /** App-owned tap handler, kept alive while the panel is closed. */
    onMetronomeTap: () => void;
    /** Saved rigs and the current rig's scenes — what a song can recall. */
    rigs: Rig[];
    sceneState: SceneState;
    /** Whether the engine is mid-rack-rebuild; the song transport locks. */
    busy: EngineBusyState;
    /** Recall a song. Routed to Rack, which owns the rig-load path — and which
        stays mounted when this panel is not. */
    onRecallSong: (song: Song) => void;
    /** Reopen the first-run audio setup. App owns the wizard (it is a modal
        over the whole window, and it outlives this panel being closed), so the
        Settings row only asks for it. */
    onOpenSetup: () => void;
    /** The tool whose panel fills the whole workspace (stage view), or null.
        Bindable: App raises it when a looper action arrives from a MIDI
        pedal — the player's eyes go to the screen exactly then — and
        session-only, like the tuner's stage overlay. */
    stagedTool?: ToolId | null;
  }

  let {
    engine,
    status,
    appSettings,
    onSetAppSettings,
    appInfo,
    capabilities,
    getReport,
    looperMidiLearning = $bindable(false),
    metronomeMidiLearning = $bindable(false),
    setlistMidiLearning = $bindable(false),
    settingsMidiLearning = $bindable(false),
    otherLearnActive = false,
    onMidiSettingsOpen,
    onMetronomeTap,
    rigs,
    sceneState,
    busy,
    onRecallSong,
    onOpenSetup,
    stagedTool = $bindable(null),
  }: Props = $props();

  // Two of the performance tools are host-owned concerns a DAW answers better
  // (see HostCapabilities), so the rail simply does not offer them there.
  function toolOffered(id: ToolId): boolean {
    if (id === 'looper') return capabilities.looper;
    if (id === 'metronome') return capabilities.metronome;
    return true;
  }
  const railTools = $derived(TOOLS.filter((tool) => toolOffered(tool.id)));

  // Which tool's panel is open is a persisted workspace preference
  // (settings.json), so the sidebar comes back the way it was left — closed by
  // default. The stage view shows its tool regardless of that preference.
  //
  // Filtered through what this host offers, because settings.json is shared
  // with the standalone: leaving the looper open in the app would otherwise
  // reopen it inside a DAW, on a panel driving a node that is not in the chain.
  const shownTool = $derived.by(() => {
    const tool = stagedTool ?? appSettings.activeTool;
    return tool !== null && toolOffered(tool) ? tool : null;
  });
  const shownDef = $derived([...TOOLS, ...UTILITY_TOOLS].find((tool) => tool.id === shownTool));

  // The Settings panel's sub-view. Session-only and reset on every rail press
  // and collapse below, so the settings panel always reopens on the main
  // list — a persisted activeTool of 'settings' restoring at launch does too,
  // because 'main' is the initial value — never on a surprise MIDI table.
  let settingsView = $state<'main' | 'midi'>('main');

  // Simple/Expert belongs to the tool, but it is a panel-level switch — it
  // reveals setup rows rather than touching tool state — so it rides in the
  // panel header beside Maximize/Collapse instead of costing the tool a row of
  // its own. Only the tools that have two depths declare one.
  const viewModeToggle = $derived.by(() => {
    // Maximized is the stage view: the tools drop their setup rows there, so
    // there is nothing left for the switch to reveal.
    if (stagedTool !== null) return null;
    if (shownTool === 'looper')
      return {
        label: 'Looper view',
        value: appSettings.looperViewMode,
        select: (mode: 'simple' | 'expert') => onSetAppSettings({ looperViewMode: mode }),
      };
    if (shownTool === 'metronome')
      return {
        label: 'Metronome view',
        value: appSettings.metronomeViewMode,
        select: (mode: 'simple' | 'expert') => onSetAppSettings({ metronomeViewMode: mode }),
      };
    if (shownTool === 'plugins')
      return {
        label: 'Packages view',
        value: appSettings.packagesViewMode,
        select: (mode: 'simple' | 'expert') => onSetAppSettings({ packagesViewMode: mode }),
      };
    return null;
  });

  // Maximize is a pedal target like the tool's own switches: a foot press
  // raises the stage view (and the next one drops it), so a player mid-song can
  // put the looper or the tempo on the whole screen without touching the mouse.
  //
  // The button lives here rather than in the tool, so the learn API comes the
  // other way: each tool's MidiLearn hands its api up (onLearnApi) and this
  // header maps its Maximize through it. Only the shown tool's api counts —
  // panels mount and unmount as the rail is clicked.
  function maximizeActionOf(tool: ToolId | null): MidiActionId | null {
    if (tool === 'looper') return 'looperMaximize';
    if (tool === 'metronome') return 'metronomeMaximize';
    if (tool === 'setlist') return 'songMaximize';
    return null;
  }

  let toolLearn = $state.raw<{ tool: ToolId; api: MidiLearnApi } | null>(null);
  // Null unless the shown tool is *in* learn mode: off-mode the button has to
  // stage, and a stale api from a panel that has since been swapped out must
  // never answer for the tool now on screen.
  const headerLearn = $derived(
    toolLearn?.tool === shownTool && toolLearn.api.on ? toolLearn.api : null,
  );
  const maximizeAction = $derived(maximizeActionOf(shownTool));

  function toggleStage() {
    stagedTool = stagedTool !== null ? null : shownTool;
  }

  function openMidiView() {
    settingsView = 'midi';
    onMidiSettingsOpen();
  }

  // A learn belongs to the panel that armed it. Switching tools or collapsing
  // the sidebar unmounts that panel, and a flag left true would keep App's
  // live MIDI dispatch paused — and every other learn switch refusing to arm —
  // with no control on screen to turn it off.
  function endSidebarLearns() {
    looperMidiLearning = false;
    metronomeMidiLearning = false;
    setlistMidiLearning = false;
    settingsMidiLearning = false;
  }

  function railClick(id: ToolId) {
    settingsView = 'main';
    endSidebarLearns();
    // A rail press while staged swaps the tool on the stage rather than tearing
    // the stage down — the player picked full size once and means to keep it.
    // Tools with no stage view (Settings, Info) still have to drop it.
    if (stagedTool !== null) {
      const canStage = [...TOOLS, ...UTILITY_TOOLS].find((tool) => tool.id === id)?.canMaximize;
      stagedTool = canStage ? id : null;
      onSetAppSettings({ activeTool: id });
      return;
    }
    onSetAppSettings({ activeTool: appSettings.activeTool === id ? null : id });
  }

  function collapse() {
    settingsView = 'main';
    endSidebarLearns();
    if (stagedTool !== null) {
      stagedTool = null;
      return;
    }
    onSetAppSettings({ activeTool: null });
  }

  /** The state dot on a rail icon: its colour, and whether it pulses. `null`
      when the tool is idle and shows no dot at all.

      Returned as data rather than as a state class on the button, because the
      button now belongs to IconButton and so carries no scope hash of ours —
      a `.looper-recording .rail-dot` ancestor rule would silently stop
      matching. A custom property and a class on the dot itself both survive. */
  function railDot(tool: ToolDef): { color: string; pulse?: 'fast' | 'slow' } | null {
    if (tool.id === 'looper') {
      switch (status.looperState) {
        case 'empty':
          return null;
        case 'armed':
          return {
            color: 'color-mix(in srgb, var(--color-danger) 65%, transparent)',
            pulse: 'slow',
          };
        case 'recording':
          return { color: 'var(--color-danger)', pulse: 'fast' };
        case 'playing':
          return { color: 'var(--color-accent)' };
        case 'overdubbing':
          return { color: 'var(--color-hot)' };
        default:
          return { color: 'color-mix(in srgb, var(--color-accent) 55%, transparent)' };
      }
    }
    if (tool.id === 'metronome' && status.metronomeEnabled) return { color: 'var(--color-accent)' };
    // No dot for the song tool: a song is always selected, so the dot was lit
    // permanently and carried no state.
    return null;
  }

  /** Replays the drawer's reveal when its already-mounted panel changes tools.
      Waiting until the next animation frame ensures the new tool is in the DOM
      before the wrapper is animated. */
  function animateToolChange(node: HTMLElement, tool: ToolId | null) {
    let previous = tool;
    let frame: number | undefined;
    let animation: Animation | undefined;

    return {
      update(next: ToolId | null) {
        if (next === previous) return;

        const wasOpen = previous !== null;
        previous = next;
        if (
          !wasOpen ||
          next === null ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        )
          return;

        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          animation?.cancel();
          animation = node.animate(
            [
              { opacity: 0, transform: 'translateX(24px)' },
              { opacity: 1, transform: 'translateX(0)' },
            ],
            { duration: 150, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
          );
          frame = undefined;
        });
      },
      destroy() {
        if (frame !== undefined) cancelAnimationFrame(frame);
        animation?.cancel();
      },
    };
  }

  /** The docked panel's own open/close: it fades and slides toward the rail
      while its width closes underneath it, so the workspace widens *with* the
      fade rather than after it.

      A plain `fly` did only the first half. The element kept its full width for
      the whole 150 ms and gave it up in one frame at the end, so the rack and
      the module drawer stood still and then jumped — and because the panel is a
      translucent chrome wash, the strip it was still occupying while it faded
      read as a black box opening between the drawer and the rail. The width is
      what the layout is waiting on, so the width is what has to move.

      Only when docked: in the stage view the panel is absolutely positioned and
      owns no width in the row, so animating one would be animating nothing —
      there the fade and the slide are the whole gesture. */
  function panelTransition(node: HTMLElement, { duration = 150 } = {}) {
    const style = getComputedStyle(node);
    const docked = style.position !== 'absolute';
    const width = parseFloat(style.width) || 0;
    return {
      duration: prefersReducedMotion.current ? 0 : duration,
      easing: cubicOut,
      css: (t: number, u: number) =>
        `opacity: ${t}; transform: translateX(${u * 24}px);` +
        (docked ? ` width: ${t * width}px; min-width: 0;` : ''),
    };
  }
</script>

<!-- The tool rail: a slim always-visible icon column on the app's right edge,
     one button per tool, VS-Code-activity-bar style, with the active tool's
     panel sliding out beside it. Rail and panel share the toolbar's surface
     and blur, and the toolbar's and status bar's hairlines stop where the
     rail begins — the three read as one continuous chrome frame around the
     rack. Both are flex siblings of the rack, never an overlay — opening a
     panel pushes the workspace narrower instead of covering modules. -->
<!-- Esc restores the stage view to the docked panel — the pedal opened it,
     the nearest key closes it. -->
<svelte:window
  onkeydown={(e) => {
    if (stagedTool !== null && e.key === 'Escape') stagedTool = null;
  }}
/>

<aside class="flex min-h-0 flex-none [zoom:var(--ui-scale,1)]" aria-label="Tools">
  {#if shownTool !== null}
    <div
      class={[
        'flex min-h-0 w-(--tool-panel-w) flex-none flex-col overflow-hidden bg-chrome backdrop-blur-[18px] transition-[width] duration-150 ease-[cubic-bezier(.33,1,.68,1)]',
        stagedTool !== null &&
          'absolute inset-y-0 right-(--tool-rail-w) left-0 z-40 w-auto bg-chrome-solid',
      ]}
      style:--tool-panel-w={shownDef?.width}
      transition:panelTransition
    >
      <div class="flex min-h-0 min-w-0 flex-1 flex-col" use:animateToolChange={shownTool}>
        <!-- The header is the panel's title bar, so it is sized to be read and
             hit from standing distance rather than tucked away: the tool name
             takes real type, and every control in it — the view switch, the
             maximize and collapse buttons — shares one 2.25rem height so the
             row reads as a single band across every tool. -->
        <header class="flex flex-none items-center justify-between gap-2 px-[.6rem] pt-2 pb-0">
          <!-- The title is the collapse control: it acts on the panel as a
               whole, so the name and its caret are one hit target sitting where
               the eye already goes, instead of a lone icon in the right-hand
               cluster. Maximized, it goes plain text — Close does this. -->
          <h2 class="flex min-w-0 items-center">
            {#if stagedTool === null}
              <IconButton
                size="md"
                class="ml-[-0.35rem] h-9 w-auto gap-1 px-[.35rem] text-[.8rem] font-semibold tracking-[.12em] uppercase"
                label="Collapse the tools sidebar"
                tip="Collapse"
                tipPlacement="bottom"
                onclick={collapse}
              >
                <span class="overflow-hidden text-ellipsis whitespace-nowrap"
                  >{shownDef?.label}</span
                >
                <CaretRightIcon size={18} class="flex-none" aria-hidden="true" />
              </IconButton>
            {:else}
              <span
                class="overflow-hidden px-[.35rem] text-[.8rem] font-semibold tracking-[.12em] text-ellipsis whitespace-nowrap text-muted uppercase"
                >{shownDef?.label}</span
              >
            {/if}
          </h2>
          <div class="flex items-center gap-[.35rem]">
            {#if viewModeToggle}
              <SegmentedControl
                compact={false}
                label={viewModeToggle.label}
                value={viewModeToggle.value}
                options={[
                  { value: 'simple', label: 'Simple' },
                  { value: 'expert', label: 'Expert' },
                ]}
                onSelect={viewModeToggle.select}
              />
            {/if}
            <!-- The song tool's depths are the rack's, not Simple/Expert: what
                 it hides in Perform is editing, so it wears the toolbar's own
                 Perform/Edit words rather than inventing a third vocabulary.
                 Maximized is the stage view — always Perform, so there is
                 nothing to switch and the control goes away. -->
            {#if shownTool === 'setlist' && stagedTool === null}
              <SegmentedControl
                compact={false}
                label="Song mode"
                value={appSettings.songEditMode}
                options={[
                  { value: false, label: 'Perform', tip: 'Call songs without editing controls' },
                  {
                    value: true,
                    label: 'Edit',
                    tip: 'Edit the book: add, rename, reorder, and map songs',
                    tone: 'accent',
                  },
                ]}
                onSelect={(mode) => onSetAppSettings({ songEditMode: mode })}
              />
            {/if}
            <!-- The Packages panel's one catalogue-wide action. In the title bar
                 rather than in the panel body because that is what it acts on —
                 the whole list, not a section of it — and the header is where
                 the panel's other whole-panel controls already are. Sized to
                 the collapse and maximize buttons so the row keeps one
                 geometry across every tool. -->
            {#if shownTool === 'plugins'}
              {@const checking = refreshPhase() === 'checking'}
              <IconButton
                size="md"
                class="h-9 w-9"
                label="Check for new plugin versions"
                tip="Check for new versions"
                tipPlacement="bottom"
                disabled={checking}
                onclick={() => requestRefresh(engine)}
              >
                <!-- The icon spins while the check is in flight; the panel says
                     what came of it. Without both, pressing this on an
                     already-current catalogue changes nothing on screen and
                     reads as a dead button. -->
                <ArrowClockwiseIcon
                  size={18}
                  class={checking ? 'animate-spin' : undefined}
                  aria-hidden="true"
                />
              </IconButton>
            {/if}
            <div class="flex items-center gap-[.15rem]">
              {#if shownDef?.canMaximize}
                <!-- In the tool's learn mode this button is a learn target like
                     the tool's own controls: the click maps it, it never
                     stages. Same three-state skin, drawn as an outline so the
                     header row keeps its geometry. -->
                {@const learnState =
                  headerLearn && maximizeAction ? learnStateOf(headerLearn, maximizeAction) : 'off'}
                {@const learnTip =
                  headerLearn && maximizeAction
                    ? headerLearn.tip(maximizeAction, 'Maximize')
                    : undefined}
                <IconButton
                  size="md"
                  class={['h-9 w-9', learnRingClass(learnState)]}
                  label={learnTip ??
                    (stagedTool !== null
                      ? 'Close the full-screen view'
                      : `Maximize the ${shownDef?.label.toLowerCase()}`)}
                  tip={learnTip ?? (stagedTool !== null ? 'Close (Esc)' : 'Maximize')}
                  tipPlacement="bottom"
                  onclick={() =>
                    headerLearn && maximizeAction
                      ? headerLearn.click(maximizeAction)
                      : toggleStage()}
                >
                  {#if stagedTool !== null}
                    <XIcon size={18} aria-hidden="true" />
                  {:else}
                    <CornersOutIcon size={18} aria-hidden="true" />
                  {/if}
                </IconButton>
              {/if}
            </div>
          </div>
        </header>
        <div
          class={[
            'min-h-0 flex-1 overflow-y-auto',
            stagedTool !== null &&
              (shownTool === 'looper' || shownTool === 'metronome') &&
              'flex flex-col justify-center',
          ]}
        >
          {#if shownTool === 'looper'}
            <LooperTool
              {engine}
              {status}
              {appSettings}
              {onSetAppSettings}
              bind:midiLearning={looperMidiLearning}
              onLearnApi={(api) => (toolLearn = { tool: 'looper', api })}
              otherLearnActive={otherLearnActive ||
                settingsMidiLearning ||
                metronomeMidiLearning ||
                setlistMidiLearning}
              large={stagedTool !== null}
            />
          {:else if shownTool === 'metronome'}
            <MetronomeTool
              {engine}
              {status}
              {appSettings}
              {onSetAppSettings}
              onTap={onMetronomeTap}
              bind:midiLearning={metronomeMidiLearning}
              onLearnApi={(api) => (toolLearn = { tool: 'metronome', api })}
              otherLearnActive={otherLearnActive ||
                settingsMidiLearning ||
                looperMidiLearning ||
                setlistMidiLearning}
              large={stagedTool !== null}
            />
          {:else if shownTool === 'setlist'}
            <SetlistTool
              {engine}
              {appSettings}
              {onSetAppSettings}
              {rigs}
              {sceneState}
              {onRecallSong}
              busy={busy.isBusy}
              bind:midiLearning={setlistMidiLearning}
              onLearnApi={(api) => (toolLearn = { tool: 'setlist', api })}
              otherLearnActive={otherLearnActive ||
                settingsMidiLearning ||
                looperMidiLearning ||
                metronomeMidiLearning}
              large={stagedTool !== null}
            />
          {:else if shownTool === 'settings'}
            <SettingsPanel
              {engine}
              {appSettings}
              {onSetAppSettings}
              {capabilities}
              view={settingsView}
              onShowMidi={openMidiView}
              {onOpenSetup}
              onBackToMain={() => (settingsView = 'main')}
              otherLearnActive={otherLearnActive ||
                looperMidiLearning ||
                metronomeMidiLearning ||
                setlistMidiLearning}
              bind:midiLearning={settingsMidiLearning}
            />
          {:else if shownTool === 'plugins'}
            <PluginsPanel {engine} expert={appSettings.packagesViewMode === 'expert'} />
          {:else if shownTool === 'info'}
            <InfoPanel
              info={appInfo}
              {getReport}
              {status}
              onOpenUrl={(url) => engine.openExternalUrl(url)}
              onRefresh={() => engine.refreshAppInfo()}
            />
          {/if}
        </div>
      </div>
    </div>
  {/if}
  <div
    class="flex w-(--tool-rail-w) flex-none flex-col items-center gap-[.3rem] border-l border-[color-mix(in_srgb,var(--color-ink)_calc(10%*var(--ink-k)),transparent)] bg-chrome py-[.45rem] backdrop-blur-[18px]"
  >
    {#snippet railButton(tool: ToolDef)}
      {@const dot = railDot(tool)}
      <IconButton
        size="md"
        class="relative"
        label={shownTool === tool.id
          ? `Hide ${tool.label.toLowerCase()}`
          : `Show ${tool.label.toLowerCase()}`}
        tip={tool.label}
        tipPlacement="left"
        aria-pressed={shownTool === tool.id}
        onclick={() => railClick(tool.id)}
      >
        <tool.icon size={22} aria-hidden="true" />
        <!-- The state survives collapsing: the dot carries the looper's colour
             (red recording, green playing, orange overdub) so a running loop is
             never invisible. -->
        {#if dot}
          <span
            class={[
              'absolute top-[.18rem] right-[.18rem] size-[.42rem] rounded-full bg-(--rail-dot-color) shadow-[0_0_5px_color-mix(in_srgb,var(--rail-dot-color)_60%,transparent)]',
              dot.pulse === 'fast' && 'animate-[rail-rec-pulse_1s_ease-in-out_infinite]',
              dot.pulse === 'slow' && 'animate-[rail-rec-pulse_1.8s_ease-in-out_infinite]',
            ]}
            style:--rail-dot-color={dot.color}
            aria-hidden="true"
          ></span>
        {/if}
      </IconButton>
    {/snippet}
    {#each railTools as tool (tool.id)}
      {@render railButton(tool)}
    {/each}
    <!-- Set-once panels live at the rail's foot, away from the performance
         tools above — the rail itself stays icons-only either way. -->
    <div class="mt-auto flex flex-col items-center gap-[.3rem]">
      {#each UTILITY_TOOLS as tool (tool.id)}
        {@render railButton(tool)}
      {/each}
    </div>
  </div>
</aside>

<style>
  @keyframes rail-rec-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
