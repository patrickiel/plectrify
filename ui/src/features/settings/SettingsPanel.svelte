<script lang="ts">
  import {
    CaretLeftIcon,
    MinusIcon,
    PianoKeysIcon,
    PlugIcon,
    PlusIcon,
    SlidersHorizontalIcon,
  } from 'phosphor-svelte';
  import { slide } from 'svelte/transition';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppSettings, MidiTrigger, ThemeName } from '../../lib/engine/types';
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
  import { createReveal } from '../../lib/components/reveal.svelte';
  import Card from '../../lib/components/Card.svelte';
  import CardRow from '../../lib/components/CardRow.svelte';
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

  // Auto standby's rows appear and disappear with one checkbox — the same
  // progressive disclosure the tool panels use, so it borrows their motion.
  const reveal = createReveal();

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
           some of them ever need. -->
      <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={onOpenSetup}>
        <PlugIcon size={15} aria-hidden="true" />
        Audio setup…
      </RowButton>
      <RowButton class="gap-2 rounded-none text-[.8rem]" onclick={() => engine.openAudioSettings()}>
        <SlidersHorizontalIcon size={15} aria-hidden="true" />
        Advanced audio…
      </RowButton>
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
         having to re-find what changed. -->
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
  </div>
{/if}
