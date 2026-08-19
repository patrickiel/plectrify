<script lang="ts">
  import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    CaretLeftIcon,
    MinusIcon,
    PianoKeysIcon,
    PlugIcon,
    PlusIcon,
    SlidersHorizontalIcon,
  } from 'phosphor-svelte';
  import { onDestroy, onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type {
    AppSettings,
    HostCapabilities,
    MidiTrigger,
    ThemeName,
  } from '../../lib/engine/types';
  import {
    MAX_RACK_ZOOM,
    MAX_UI_SCALE,
    MIN_RACK_ZOOM,
    MIN_UI_SCALE,
    RACK_ZOOM_STEP,
    STANDBY_DEEP_DELAYS,
    STANDBY_LIGHT_DELAYS,
    STANDBY_THRESHOLDS,
    UI_SCALE_STEP,
  } from '../../lib/engine/appSettings';
  import {
    backupFileName,
    describeBackupError,
    describeRestoreOutcome,
    IDLE_BACKUP,
    platformSlug,
    type BackupState,
  } from '../../lib/engine/backup';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import Card from '../../lib/components/Card.svelte';
  import CardRow from '../../lib/components/CardRow.svelte';
  import InlineConfirmRow from '../../lib/components/InlineConfirmRow.svelte';
  import MenuCheckbox from '../../lib/components/MenuCheckbox.svelte';
  import RowButton from '../../lib/components/RowButton.svelte';
  import Select from '../../lib/components/Select.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import ToolbarButton from '../../lib/components/ToolbarButton.svelte';
  import ToolbarButtonGroup from '../../lib/components/ToolbarButtonGroup.svelte';
  import MidiSettingsPanel from './MidiSettingsPanel.svelte';

  interface Props {
    engine: EngineBridge;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Which host-owned facilities exist — standalone-only rows (audio setup,
        Auto Standby, backup) hide where a DAW owns those concerns. */
    capabilities: HostCapabilities;
    /** Which OS this build runs on, for the restore dialog's note about an
        archive made on the other one. Absent on an engine older than the
        field, which simply means the note is not offered. */
    platform?: 'windows' | 'macos';
    /** Which view the panel shows: the settings list, or the MIDI learn
        table it links to. Owned by ToolSidebar so it can reset to 'main'
        whenever the panel closes. */
    view: 'main' | 'midi';
    onShowMidi: () => void;
    /** Reopen the first-run audio setup — App owns the wizard itself. */
    onOpenSetup: () => void;
    onBackToMain: () => void;
    /** True while a MIDI learn outside this panel is armed. */
    otherLearnActive?: boolean;
    /** Bindable mirror of the MIDI view's armed learn — see MidiSettingsPanel. */
    midiLearning?: boolean;
  }

  let {
    engine,
    appSettings,
    onSetAppSettings,
    capabilities,
    platform,
    view,
    onShowMidi,
    onOpenSetup,
    onBackToMain,
    otherLearnActive = false,
    midiLearning = $bindable(false),
  }: Props = $props();

  /** Clamp and round to the 0.05 grid the engine normalizes to — otherwise
      repeated ± clicks accumulate float error until the echo corrects them. */
  const scaleSetter = (key: 'rackZoom' | 'uiScale', min: number, max: number) => (next: number) => {
    const clamped = Math.max(min, Math.min(max, next));
    onSetAppSettings({ [key]: Math.round(clamped * 20) / 20 });
  };
  const setRackZoom = scaleSetter('rackZoom', MIN_RACK_ZOOM, MAX_RACK_ZOOM);
  const setUiScale = scaleSetter('uiScale', MIN_UI_SCALE, MAX_UI_SCALE);

  // Discrete choices rather than sliders: every write rewrites settings.json
  // over the bridge, so a dragged control would hammer it.
  const minuteOptions = (minutes: readonly number[]) =>
    minutes.map((m) => ({
      value: String(m),
      label: m < 60 ? `${m} min` : `${m / 60} h`,
    }));
  const lightDelayOptions = minuteOptions(STANDBY_LIGHT_DELAYS);
  // "Never" is the stored 0, not a separate flag — so the off state is just the
  // first choice in the same list rather than a checkbox above it.
  const deepDelayOptions = [{ value: '0', label: 'Never' }, ...minuteOptions(STANDBY_DEEP_DELAYS)];
  const thresholdOptions = STANDBY_THRESHOLDS.map((db) => ({
    value: String(db),
    label: `${db} dB`,
  }));
  const deepEnabled = $derived(appSettings.standbyDeepAfterMinutes > 0);

  /** How long a finished restore's line stays up before the page reloads. Long
      enough to read one sentence, short enough that nobody wonders whether the
      app has hung. */
  const RESTORE_READ_MS = 1600;

  // Auto standby's rows appear and disappear with one checkbox — the same
  // progressive disclosure the tool panels use, so it borrows their motion.
  const reveal = createReveal();

  // Backup and restore. The engine owns the file dialog, the archive and the
  // replacement; this reads one state stream and decides what to put on screen.
  //
  // Everything happens in this card — the confirm, the progress and the result.
  // No dialog: the whole interaction is two rows and a line of text, and a
  // modal over the entire app for that is a scrim, a scrim animation and a trip
  // to the middle of the screen to answer a question that was asked in the
  // corner. The rest of the app stays visible and usable, which is also the
  // honest picture: nothing is blocked until the OS file dialog opens.
  let backup = $state<BackupState>({ ...IDLE_BACKUP });
  let confirmRestore = $state(false);
  onMount(() =>
    engine.subscribeBackup((state) => {
      backup = state;
      // A restored machine has to reload: the engine has replaced
      // working-rack.json and settings.json under this page, and JuceEngine's
      // boot is what reads them. Owed from the moment the files land rather
      // than from a click — until it happens the page shows the rack and the
      // preferences of the installation the archive replaced, and its own
      // writes are suppressed. So it is taken automatically, after just long
      // enough to read the line saying what arrived.
      if (state.action === 'restore' && state.phase === 'done')
        setTimeout(() => location.reload(), RESTORE_READ_MS);
    }),
  );

  // A file dialog is open or an archive is being read: both rows go quiet
  // rather than queueing a second run behind the first.
  const busy = $derived(backup.phase === 'choosing' || backup.phase === 'working');
  const restored = $derived(backup.action === 'restore' && backup.phase === 'done');

  /** The one line under the rows. It is the card's whole feedback channel, so
      it carries the standing description as well as every outcome — one line
      that changes rather than a line that appears, which would make the card
      grow and shrink under the pointer. */
  const statusLine = $derived.by(() => {
    if (backup.phase === 'choosing')
      return backup.action === 'backup' ? 'Choose where to save it…' : 'Choose a backup…';
    if (backup.phase === 'working')
      return backup.action === 'backup' ? 'Writing the backup…' : 'Restoring…';
    if (backup.phase === 'failed') return describeBackupError(backup.error);
    if (restored) return describeRestoreOutcome(backup, platformSlug(platform)) + ' Reloading…';
    if (backup.action === 'backup' && backup.phase === 'done')
      return `Saved as ${backupFileName(backup.path)}`;
    return 'Rigs, patches, songs and settings, in one file. Plugins and downloaded captures are not included.';
  });

  // And taken at once if the panel closes before that pause is up, rather than
  // leaving the app running against a disk it no longer matches.
  onDestroy(() => {
    if (backup.action === 'restore' && backup.phase === 'done') location.reload();
  });

  const setTheme = (theme: ThemeName) => onSetAppSettings({ theme });
  const setBindings = (settings: { midiBindings: Record<string, MidiTrigger> }) =>
    onSetAppSettings(settings);
</script>

{#if view === 'midi'}
  <!-- Full height, so the MIDI view's binding lists can flex into whatever the
       sidebar leaves them rather than running at their natural length. -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- The back row carries the view's identity: where you are, and the one
         way out that isn't Esc. -->
    <button
      type="button"
      class="flex w-full flex-none cursor-pointer items-center gap-[.4rem] px-[.6rem] pt-2 pb-0 text-left text-[.8rem] font-medium text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ink)_7%,transparent)] hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      onclick={onBackToMain}
    >
      <CaretLeftIcon size={14} aria-hidden="true" />
      MIDI settings
    </button>
    <MidiSettingsPanel
      {engine}
      midiDevicesAvailable={capabilities.midiDevices}
      midiBindings={appSettings.midiBindings}
      onSetAppSettings={setBindings}
      {otherLearnActive}
      bind:midiLearning
    />
  </div>
{:else}
  <!-- Cards, not ruled sections: one surface per group of settings, the card's
       own border doing the separating. Same language as the looper. -->
  <div class="flex flex-col gap-[.5rem] px-[.6rem] pt-2 pb-[.6rem]">
    <Card>
      <!-- First, and named for the question rather than for the panel: this is
           the one every player has to answer, and the row below is the one only
           some of them ever need. In a DAW neither exists — the host owns the
           audio device — while MIDI settings stay: bindings still work there. -->
      {#if capabilities.audioDevices}
        <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={onOpenSetup}>
          <PlugIcon size={15} aria-hidden="true" />
          Audio setup…
        </RowButton>
        <RowButton
          class="gap-2 rounded-none text-[.8rem]"
          onclick={() => engine.openAudioSettings()}
        >
          <SlidersHorizontalIcon size={15} aria-hidden="true" />
          Advanced audio…
        </RowButton>
      {/if}
      <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={onShowMidi}>
        <PianoKeysIcon size={15} aria-hidden="true" />
        MIDI settings…
      </RowButton>
    </Card>
    <!-- Still the fused −/readout/+ group, so the readout stays the click
         that returns to 100%. One shape for both scales: the rack's zoom and
         the chrome's (toolbar + sidebar + status bar as one setting). The
         card's header carries the "zoom", so the rows just name the target;
         `name` is the full spoken phrase for screen readers and tooltips. -->
    {#snippet scaleRow(
      label: string,
      name: string,
      value: number,
      min: number,
      max: number,
      step: number,
      apply: (next: number) => void,
    )}
      <CardRow {label} class="font-sans text-[.8rem] font-medium">
        <ToolbarButtonGroup label={name}>
          <ToolbarButton
            size="sm"
            iconOnly
            label={`Decrease ${name}`}
            disabled={value <= min}
            onclick={() => apply(value - step)}
          >
            <MinusIcon size={14} weight="bold" />
          </ToolbarButton>
          <ToolbarButton
            size="sm"
            label={`Reset ${name} to 100%. Currently ${Math.round(value * 100)}%`}
            tip={`Reset ${name} to 100%`}
            tipPlacement="left"
            class="min-w-[3.4rem] font-mono text-[0.72rem] font-bold tabular-nums"
            onclick={() => apply(1)}
          >
            {Math.round(value * 100)}%
          </ToolbarButton>
          <ToolbarButton
            size="sm"
            iconOnly
            label={`Increase ${name}`}
            disabled={value >= max}
            onclick={() => apply(value + step)}
          >
            <PlusIcon size={14} weight="bold" />
          </ToolbarButton>
        </ToolbarButtonGroup>
      </CardRow>
    {/snippet}
    <Card>
      <p
        class="px-[.6rem] py-[.35rem] text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase"
      >
        Zoom
      </p>
      {@render scaleRow(
        'Rack',
        'rack zoom',
        appSettings.rackZoom,
        MIN_RACK_ZOOM,
        MAX_RACK_ZOOM,
        RACK_ZOOM_STEP,
        setRackZoom,
      )}
      {@render scaleRow(
        'Interface',
        'interface zoom',
        appSettings.uiScale,
        MIN_UI_SCALE,
        MAX_UI_SCALE,
        UI_SCALE_STEP,
        setUiScale,
      )}
      <!-- A segmented control rather than a "Light theme" checkbox: the setting
           is a choice between named themes, and a checkbox would leave that
           mutual exclusivity implicit. -->
      <CardRow label="Appearance" class="font-sans text-[.8rem] font-medium">
        <SegmentedControl
          label="Appearance"
          value={appSettings.theme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
          onSelect={setTheme}
        />
      </CardRow>
    </Card>
    <!-- Auto Standby. Named after the amp switch it behaves like, and off by
         default: nothing may silence or unload a rig on stage unless the user
         asked for it.

         One toggle over three uniform rows. Unloading is a delay like the
         others with "Never" as its off value — which is exactly how the
         setting is stored — so it needs no checkbox of its own, and the list
         stays flat. The rows are dropped rather than dimmed when the toggle
         is off: three delays that govern nothing are noise, and their
         appearing *is* the feedback that the toggle took — which is why they
         slide rather than snap, so the eye follows the card growing instead of
         having to re-find what changed.

         Whole card gated away in a DAW: suspension is the host's business
         (offline render, freeze), and controls that govern nothing are noise. -->
    {#if capabilities.autoStandby}
      <Card>
        <div>
          <MenuCheckbox
            checked={appSettings.standbyEnabled}
            label="Auto standby"
            onChange={(checked) => onSetAppSettings({ standbyEnabled: checked })}
          />
          <p
            class="mt-[-.15rem] pt-0 pr-[.6rem] pb-[.4rem] pl-[1.95rem] text-[.7rem] leading-[1.35] text-[color-mix(in_srgb,var(--color-ink)_45%,transparent)]"
          >
            Saves CPU and RAM while the guitar is quiet.
          </p>
        </div>

        {#if appSettings.standbyEnabled}
          <div transition:slide={reveal.slide()}>
            <CardRow label="Suspend after" class="font-sans text-[.8rem] font-medium">
              <Select
                options={lightDelayOptions}
                value={String(appSettings.standbyLightAfterMinutes)}
                filterable={false}
                size="sm"
                variant="plain"
                class="h-[1.65rem] min-w-[5.5rem]"
                aria-label="Suspend the rig after"
                onSelect={(value) => onSetAppSettings({ standbyLightAfterMinutes: Number(value) })}
              />
            </CardRow>
            <CardRow label="Wake above" class="font-sans text-[.8rem] font-medium">
              <Select
                options={thresholdOptions}
                value={String(appSettings.standbyWakeThresholdDb)}
                filterable={false}
                size="sm"
                variant="plain"
                class="h-[1.65rem] min-w-[5.5rem]"
                aria-label="Wake when the input rises above"
                onSelect={(value) => onSetAppSettings({ standbyWakeThresholdDb: Number(value) })}
              />
            </CardRow>
            <CardRow label="Unload plugins" class="font-sans text-[.8rem] font-medium">
              <Select
                options={deepDelayOptions}
                value={String(appSettings.standbyDeepAfterMinutes)}
                filterable={false}
                size="sm"
                variant="plain"
                class="h-[1.65rem] min-w-[5.5rem]"
                aria-label="Unload the plugins after"
                onSelect={(value) => onSetAppSettings({ standbyDeepAfterMinutes: Number(value) })}
              />
            </CardRow>
            <!-- Shown only once unloading is actually on: it is the one part of
               this feature with a cost, and the default state stays clean. -->
            {#if deepEnabled}
              <p
                class="mt-[-.25rem] px-[.6rem] pb-[.4rem] text-[.7rem] leading-[1.35] text-[color-mix(in_srgb,var(--color-ink)_45%,transparent)]"
                transition:slide={reveal.slide()}
              >
                Waking then reloads the rig, which takes a moment.
              </p>
            {/if}
          </div>
        {/if}
      </Card>
    {/if}
    <!-- Backup. Last, because it is the one card nobody opens Settings to
         reach until the day they need it — and the only one whose second row
         can undo everything above it.

         Gated away in a DAW: a session's rack rides the project document, so
         an archive of the *global* rigs and settings is not what that session
         owns, and a restore would replace them under every other instance at
         once. -->
    {#if capabilities.backup}
      <Card>
        <p
          class="px-[.6rem] py-[.35rem] text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase"
        >
          Backup
        </p>
        <RowButton
          class="gap-2 rounded-none text-[.8rem]"
          disabled={busy}
          onclick={() => engine.createBackup()}
        >
          <ArchiveIcon size={15} aria-hidden="true" />
          Back up…
        </RowButton>
        <!-- The confirm takes over the row it belongs to, so what is about to
             be replaced stays on screen above it and the row's own action
             cannot be hit mid-confirm. Same component the rig menu's Discard
             and every delete row in the app use. -->
        {#if confirmRestore}
          <InlineConfirmRow
            stacked
            message="Replace your rigs, patches, songs and settings with a backup's? A copy of what is here now is saved first."
            confirmLabel="Replace…"
            onConfirm={() => {
              confirmRestore = false;
              engine.restoreBackup();
            }}
            onCancel={() => (confirmRestore = false)}
          />
        {:else}
          <RowButton
            class="gap-2 rounded-none text-[.8rem]"
            disabled={busy}
            onclick={() => (confirmRestore = true)}
          >
            <ArrowCounterClockwiseIcon size={15} aria-hidden="true" />
            Restore…
          </RowButton>
        {/if}
        <p
          class="px-[.6rem] pb-[.4rem] text-[.7rem] leading-[1.35] {backup.phase === 'failed'
            ? 'text-warn'
            : 'text-[color-mix(in_srgb,var(--color-ink)_45%,transparent)]'}"
          role="status"
          title={backup.path || undefined}
        >
          {statusLine}
        </p>
      </Card>
    {/if}
  </div>
{/if}
