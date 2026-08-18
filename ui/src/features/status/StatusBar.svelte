<script lang="ts">
  import { onMount } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppSettings, HostCapabilities, StatusState } from '../../lib/engine/types';
  import { assignBinding, clearBinding, isPress, triggerOf } from '../../lib/engine/midi';
  import FeedbackPanel from './FeedbackPanel.svelte';
  import GainMeter from './GainMeter.svelte';
  import MuteButton from './MuteButton.svelte';
  import TunerPanel from './TunerPanel.svelte';
  import TunerReadout from './TunerReadout.svelte';

  interface Props {
    engine: EngineBridge;
    status: StatusState;
    onSetStatus: (
      status: Partial<
        Pick<
          StatusState,
          | 'inputGainDb'
          | 'outputGainDb'
          | 'tunerEnabled'
          | 'midiTunerActive'
          | 'feedbackGuardEnabled'
          | 'feedbackMuted'
          | 'outputMuted'
        >
      >,
    ) => void;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Gates the feedback-guard slideout alone. The MUTE pill it sits above is
        never gated — a hand mute is a panic control every host owes the
        player. */
    capabilities: HostCapabilities;
    /** True while the tuner's MIDI learn is armed. Bindable so App can hand it
        to the rack, whose live MIDI dispatch pauses during a learn — the press
        being captured must not also fire whatever it was bound to before. */
    tunerMidiLearning?: boolean;
    /** Same shape for the mute's learn, armed from the pill's slideout. */
    muteMidiLearning?: boolean;
    /** True while a MIDI learn elsewhere (the rack's knob/module/lane learn,
        or the looper's in the sidebar) is armed. The tuner's Learn refuses to
        arm a second one. */
    otherLearnActive?: boolean;
  }

  let {
    engine,
    status,
    onSetStatus,
    appSettings,
    onSetAppSettings,
    capabilities,
    tunerMidiLearning = $bindable(false),
    muteMidiLearning = $bindable(false),
    otherLearnActive = false,
  }: Props = $props();
  // Which readout to draw is a persisted preference (settings.json), but a
  // strobe is nothing *but* motion, so a system asking for less of it gets the
  // needle — without the stored choice being discarded.
  const tunerDisplay = $derived(appSettings.tunerDisplay);
  const reduceMotion = $derived(prefersReducedMotion.current);
  const tunerReadoutActive = $derived(status.tunerEnabled || status.midiTunerActive);
  // Clicking changes only the manual status-bar preference; hovering it (or
  // focusing it, for keyboards) slides out the display and MIDI options.
  let tunerHovered = $state(false);
  let tunerFocused = $state(false);
  // An armed MIDI learn holds the slideout open on its own: the user's next
  // move is a footswitch (or a walk to the pedalboard), not keeping a pointer
  // parked on the tuner — and "Listening…" must stay visible until the press
  // lands or the learn is cancelled.
  const tunerPanelOpen = $derived(tunerHovered || tunerFocused || tunerMidiLearning);

  // The mute pill's own slideout, opened the same way: the button is the whole
  // control in a hurry, and the guard's preference is what waits behind a hover.
  let mutePanelHovered = $state(false);
  let mutePanelFocused = $state(false);
  // An armed learn holds it open on its own, same as the tuner's: the next move
  // is a footswitch, not keeping a pointer parked on the pill.
  const mutePanelOpen = $derived(mutePanelHovered || mutePanelFocused || muteMidiLearning);

  // --- MIDI bindings learned right here in the bar --------------------------
  // The tuner's, beside the readout it toggles, and the mute's, beside the pill
  // it presses — both away from the MIDI dialog for the same reason.
  const tunerMidiBinding = $derived(appSettings.midiBindings['tunerToggle']);
  const muteMidiBinding = $derived(appSettings.midiBindings['outputMute']);

  // Learn capture: first press while armed becomes the binding (releases are
  // ignored, conflicts are last-learn-wins — same semantics as the MIDI
  // settings dialog's Learn buttons). onMount rather than $effect: the engine
  // is created once for the app's lifetime, so there is nothing to react to.
  // Only ever one of the two is armed — each Learn refuses while another is.
  onMount(() =>
    engine.subscribeMidiEvents((events) => {
      const action = tunerMidiLearning ? 'tunerToggle' : muteMidiLearning ? 'outputMute' : null;
      if (action === null) return;
      const press = events.find(isPress);
      if (!press) return;
      onSetAppSettings({
        midiBindings: assignBinding(appSettings.midiBindings, action, triggerOf(press)),
      });
      tunerMidiLearning = false;
      muteMidiLearning = false;
    }),
  );

  /** Only keyboard focus may hold a panel open. Clicking a button inside one
      focuses it too, and counting that would latch the panel open after the
      pointer has left — :focus-visible is exactly the click/keyboard split. */
  function focusIsKeyboard(event: FocusEvent) {
    const target = event.target as HTMLElement | null;
    return target?.matches?.(':focus-visible') ?? false;
  }

  /** True when focus left the zone altogether. Moving between a zone's toggle
      and its panel stays inside, which is what stops the panel from vanishing
      out from under a Tab. */
  function focusLeftZone(event: FocusEvent) {
    const zone = event.currentTarget as HTMLElement;
    return !zone.contains(event.relatedTarget as Node | null);
  }

  function toggleTuner() {
    // While the stage tuner is up, the slot is showing its dismiss hint rather
    // than a readout — so the click has to close the overlay, not toggle a
    // readout that isn't there. "Click anywhere" has to include the words.
    if (status.midiTunerActive) onSetStatus({ midiTunerActive: false });
    else onSetStatus({ tunerEnabled: !status.tunerEnabled });
  }

  // Auto Standby's state belongs on the IN meter: it is that meter falling
  // silent that engages it, and the meter is what the user watches to confirm
  // the rig is listening again. It takes the readout's slot because a parked
  // rig has no level worth reading.
  const standbyLabel = $derived.by(() => {
    switch (status.standbyStage) {
      case 'light':
        return 'ZZZ';
      case 'deep':
        return 'PARKED';
      case 'waking':
        return 'WAKING';
      default:
        return '';
    }
  });
  const standbyTitle = $derived(
    status.standbyStage === 'deep'
      ? 'Plugins unloaded to free RAM — play to reload the rig'
      : status.standbyStage === 'waking'
        ? 'Reloading the rig'
        : 'Rig suspended to save CPU — play to wake it',
  );
</script>

{#snippet standbyBadge()}
  <span
    class="w-10 rounded-[.2rem] bg-[color-mix(in_srgb,var(--color-ink)_calc(12%*var(--ink-k)),transparent)] py-[.2rem] text-center font-mono text-[calc(var(--footer-font-size)*.82)] leading-normal font-bold tracking-[.03em] text-[color-mix(in_srgb,var(--color-ink)_55%,transparent)]"
    title={standbyTitle}>{standbyLabel}</span
  >
{/snippet}

<footer
  class="relative z-70 grid h-10 w-full flex-none [zoom:var(--ui-scale,1)] grid-cols-[1fr_minmax(11rem,21rem)_1fr] items-center bg-(--bar-surface) backdrop-blur-2xl [--bar-surface:var(--color-chrome)] [--footer-font-size:.75rem] before:absolute before:top-[-1px] before:right-(--tool-rail-w) before:left-0 before:h-px before:bg-[color-mix(in_srgb,var(--color-ink)_calc(10%*var(--ink-k)),transparent)] before:content-[''] max-[1100px]:grid-cols-[1fr_minmax(10rem,15rem)_1fr] max-[860px]:grid-cols-[1fr_minmax(9rem,12rem)_1fr] max-[620px]:grid-cols-[1fr_minmax(7rem,9rem)_1fr]"
  aria-label="Input, tuner, and output status"
>
  <GainMeter
    side="input"
    label="IN"
    peak={status.inputPeak}
    gainDb={status.inputGainDb}
    onSetGain={(db) => onSetStatus({ inputGainDb: db })}
    badge={standbyLabel ? standbyBadge : undefined}
  />

  <section
    class="relative flex h-full w-full items-center before:absolute before:top-1/2 before:left-0 before:h-5 before:w-px before:-translate-y-1/2 before:bg-[color-mix(in_srgb,var(--color-ink)_calc(16%*var(--ink-k)),transparent)] before:content-[''] after:absolute after:top-1/2 after:right-0 after:h-5 after:w-px after:-translate-y-1/2 after:bg-[color-mix(in_srgb,var(--color-ink)_calc(16%*var(--ink-k)),transparent)] after:content-['']"
    aria-label="Guitar tuner"
    onpointerenter={() => (tunerHovered = true)}
    onpointerleave={() => (tunerHovered = false)}
    onfocusin={(e) => {
      if (focusIsKeyboard(e)) tunerFocused = true;
    }}
    onfocusout={(e) => {
      if (focusLeftZone(e)) tunerFocused = false;
    }}
  >
    <button
      class={[
        'flex h-full w-full cursor-pointer items-center rounded-[.3rem] border-0 bg-transparent px-[.7rem] transition-opacity duration-120 hover:bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)] max-[860px]:px-2 max-[620px]:px-[.45rem]',
        !tunerReadoutActive && 'opacity-45',
      ]}
      aria-label={status.midiTunerActive
        ? 'Close the full-size tuner'
        : 'Toggle status-bar guitar tuner'}
      aria-pressed={status.midiTunerActive ? undefined : status.tunerEnabled}
      onclick={toggleTuner}
    >
      <!-- The stage tuner is the same readout, larger and already in the user's
           eyeline, so the bar's copy would only be a second strobe competing
           with it. The slot keeps its width — and stays the toggle's hit area
           and the slideout's anchor — by carrying the overlay's dismiss hint,
           which is off the stage surface itself for the same reason: nothing
           should share space with the readout the player is watching. -->
      {#if status.midiTunerActive}
        <span
          class="w-full overflow-hidden text-center font-mono text-[calc(var(--footer-font-size)*.84)] leading-normal font-medium tracking-[.04em] text-ellipsis whitespace-nowrap text-[color-mix(in_srgb,var(--color-ink)_calc(42%*var(--ink-k)),transparent)]"
          >Click anywhere to close</span
        >
      {:else}
        <TunerReadout
          active={tunerReadoutActive}
          reading={status.tunerReading}
          display={tunerDisplay}
          strobePrecision={appSettings.tunerStrobePrecision}
          needlePrecision={appSettings.tunerNeedlePrecision}
          {reduceMotion}
        />
      {/if}
    </button>
    {#if tunerPanelOpen}
      <TunerPanel
        display={tunerDisplay}
        strobePrecision={appSettings.tunerStrobePrecision}
        needlePrecision={appSettings.tunerNeedlePrecision}
        {reduceMotion}
        midiBinding={tunerMidiBinding}
        midiLearning={tunerMidiLearning}
        fullSizeActive={status.midiTunerActive}
        onSetDisplay={(display) => onSetAppSettings({ tunerDisplay: display })}
        onSetStrobePrecision={(precision) => onSetAppSettings({ tunerStrobePrecision: precision })}
        onSetNeedlePrecision={(precision) => onSetAppSettings({ tunerNeedlePrecision: precision })}
        onToggleFullSize={() => onSetStatus({ midiTunerActive: !status.midiTunerActive })}
        onMidiLearnToggle={() => {
          // One armed learn app-wide — including the mute's, its neighbour.
          if (!tunerMidiLearning && (otherLearnActive || muteMidiLearning)) return;
          tunerMidiLearning = !tunerMidiLearning;
        }}
        onMidiClear={() => {
          if (status.midiTunerActive) onSetStatus({ midiTunerActive: false });
          onSetAppSettings({ midiBindings: clearBinding(appSettings.midiBindings, 'tunerToggle') });
        }}
      />
    {/if}
  </section>

  <!-- The mute rides beside the OUT meter because that is the level it
       silences, and ahead of it rather than in the readout slot: the OUT dB
       figure and the CLIP badge already share that one cell, and a mute the
       user has to clear must not be what hides them. The pill is the whole
       control — the guard's on/off is a preference, so it slides out on hover
       the way the tuner's settings do, while what a player reaches for in a
       hurry stays on the bar. -->
  <div class="flex h-full min-w-0 items-center justify-end gap-2 justify-self-end">
    <section
      class="relative flex h-full items-center"
      aria-label="Output mute and feedback protection"
      onpointerenter={() => (mutePanelHovered = true)}
      onpointerleave={() => (mutePanelHovered = false)}
      onfocusin={(e) => {
        if (focusIsKeyboard(e)) mutePanelFocused = true;
      }}
      onfocusout={(e) => {
        if (focusLeftZone(e)) mutePanelFocused = false;
      }}
    >
      <MuteButton
        muted={status.outputMuted}
        feedbackMuted={status.feedbackMuted}
        onToggle={() => onSetStatus({ outputMuted: !status.outputMuted })}
        onClearFeedback={() => onSetStatus({ feedbackMuted: false, outputMuted: false })}
      />
      {#if mutePanelOpen && capabilities.feedbackGuard}
        <FeedbackPanel
          enabled={status.feedbackGuardEnabled}
          tripped={status.feedbackMuted}
          onToggle={(enabled) => onSetStatus({ feedbackGuardEnabled: enabled })}
          midiBinding={muteMidiBinding}
          midiLearning={muteMidiLearning}
          onMidiLearnToggle={() => {
            if (!muteMidiLearning && (otherLearnActive || tunerMidiLearning)) return;
            muteMidiLearning = !muteMidiLearning;
          }}
          onMidiClear={() =>
            onSetAppSettings({
              midiBindings: clearBinding(appSettings.midiBindings, 'outputMute'),
            })}
        />
      {/if}
    </section>
    <GainMeter
      side="output"
      label="OUT"
      peak={status.outputPeak}
      gainDb={status.outputGainDb}
      onSetGain={(db) => onSetStatus({ outputGainDb: db })}
    />
  </div>
</footer>
