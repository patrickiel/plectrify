<script lang="ts">
  import { createSubscriber } from 'svelte/reactivity';
  import { slide } from 'svelte/transition';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppSettings, StatusState } from '../../lib/engine/types';
  import { extrapolatePosition, formatLoopSeconds } from './looperPosition';
  import type { LooperSnapshot } from './looperPosition';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import CardRow from '../../lib/components/CardRow.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import { onEnterEscape } from '../../lib/components/textInputBehaviors';
  import MidiLearn, { type MidiLearnApi } from '../../lib/components/MidiLearn.svelte';
  import { learnRingClass, learnStateOf } from '../../lib/components/learnSkin';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import LooperSessions from './LooperSessions.svelte';

  interface Props {
    engine: EngineBridge;
    status: StatusState;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** True while this looper's MIDI learn is armed. Bindable so App can hand
        it to the rack, whose live MIDI dispatch pauses during a learn. */
    midiLearning?: boolean;
    /** True while a MIDI learn elsewhere (tuner, rack) is armed; the looper's
        Learn refuses to arm a second one. */
    otherLearnActive?: boolean;
    /** Stage-view layout: the card scales up to be readable from standing
        distance when the sidebar is maximized. */
    large?: boolean;
    /** Hands this card's learn API to the panel header, whose Maximize button
        is one of the actions mapped here. */
    onLearnApi?: (api: MidiLearnApi<LooperMidiAction>) => void;
  }

  let {
    engine,
    status,
    appSettings,
    onSetAppSettings,
    midiLearning = $bindable(false),
    otherLearnActive = false,
    large = false,
    onLearnApi,
  }: Props = $props();

  const looperState = $derived(status.looperState);
  const expert = $derived(appSettings.looperViewMode === 'expert');
  // Motion for what Expert reveals — see reveal.svelte.ts.
  const reveal = createReveal();

  // --- MIDI learn mode -------------------------------------------------------
  // MidiLearn wraps the card: its switch flips the real controls — the pedal,
  // Stop, Clear, Undo — into learn targets, so "map the stop switch" is
  // literally "click Stop, press the switch". The bindable midiLearning
  // boolean *is* the mode: App pauses the rack's live dispatch while it is on
  // (a press meant for a mapping must not also fire what it was bound to
  // before), and disarms it from outside when the MIDI settings dialog opens.
  // looperMaximize is mapped here too even though its button lives in the panel
  // header: the header hands MidiLearn's API back up (onLearnApi) so Maximize
  // becomes a learn target alongside the transport it belongs to.
  type LooperMidiAction =
    'looperToggle' | 'looperStop' | 'looperClear' | 'looperUndo' | 'looperMaximize';
  const LOOPER_ACTIONS: LooperMidiAction[] = [
    'looperToggle',
    'looperStop',
    'looperClear',
    'looperUndo',
    'looperMaximize',
  ];

  // The playhead arrives at 15 Hz; a requestAnimationFrame loop extrapolates
  // between pushes so the ring sweeps instead of stepping. The snapshot's
  // arrival stamp is taken on the first read after a push — within a frame of
  // the push itself, which is all the precision a progress ring needs.
  const snapshot = $derived<LooperSnapshot>({
    state: status.looperState,
    position: status.looperPosition,
    lengthSeconds: status.looperLengthSeconds,
    receivedAtMs: performance.now(),
  });
  const animating = $derived(
    looperState === 'recording' || looperState === 'playing' || looperState === 'overdubbing',
  );
  // A reactive frame clock instead of an $effect-driven rAF loop: the rAF
  // only runs while some live derived/template actually reads frameNow(),
  // and no derived is ever read from an async callback — which is what used
  // to trip Svelte's derived_inert warning. displayPosition below stops
  // calling frameNow() when the looper isn't moving, so the subscription
  // (and the rAF) drops out by itself.
  let now = 0;
  const subscribeToFrames = createSubscriber((update) => {
    let raf = requestAnimationFrame(function tick() {
      now = performance.now();
      update();
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });
  function frameNow(): number {
    subscribeToFrames();
    return now;
  }
  const displayPosition = $derived(
    animating ? extrapolatePosition(snapshot, frameNow()) : snapshot.position,
  );

  // r=21 in a 48-box; drawn from 12 o'clock via the -90° rotation.
  const CIRCUMFERENCE = 2 * Math.PI * 21;

  const stateLabel = $derived.by(() => {
    switch (looperState) {
      case 'armed':
        return 'ARMED';
      case 'recording':
        return 'RECORDING';
      case 'playing':
        return 'PLAYING';
      case 'overdubbing':
        return 'OVERDUB';
      case 'stopped':
        return 'STOPPED';
      default:
        return 'NEW LOOP';
    }
  });
  const mainVerb = $derived.by(() => {
    switch (looperState) {
      case 'empty':
        return 'Record';
      case 'armed':
        return 'Record now';
      case 'recording':
        return 'Play';
      case 'playing':
        return 'Overdub';
      case 'overdubbing':
        return 'Play';
      default:
        return 'Play';
    }
  });
  // Trigger sensitivity presets: how loud the first note has to be. Spread
  // across the engine's clamp (-70…-20 dBFS) so the three steps are audibly
  // different rigs — Low ignores a noisy rig's hiss and wants a deliberate
  // strum, High catches soft fingerpicking. The dB box beside them takes any
  // value in between; the engine clamps whatever it gets.
  const ARM_DB_MIN = -70;
  const ARM_DB_MAX = -20;
  const SENSITIVITIES: { label: string; db: number }[] = [
    { label: 'Low', db: -25 },
    { label: 'Med', db: -45 },
    { label: 'High', db: -65 },
  ];

  // The box tracks the engine value until the user starts typing in it, so a
  // preset click is reflected there without stealing a half-typed number.
  let armDbDraft = $state<string | null>(null);
  const armDbText = $derived(armDbDraft ?? String(Math.round(status.looperArmThresholdDb)));

  function commitArmDb() {
    const parsed = Number(armDbDraft);
    if (armDbDraft !== null && armDbDraft.trim() !== '' && Number.isFinite(parsed))
      engine.setStatus({
        looperArmThresholdDb: Math.min(ARM_DB_MAX, Math.max(ARM_DB_MIN, Math.round(parsed))),
      });
    armDbDraft = null;
  }

  const mainHint = $derived.by(() => {
    switch (looperState) {
      case 'empty':
        return status.looperArmEnabled
          ? 'Arm the looper — recording starts on your first note'
          : 'Start recording a loop';
      case 'armed':
        return 'Waiting for your first note; click to record now';
      case 'recording':
        return 'Close the loop and play';
      case 'playing':
        return 'Overdub on top of the loop';
      case 'overdubbing':
        return 'Finish the overdub';
      default:
        return 'Restart the loop from the top';
    }
  });
  // Before there is a loop, use the clock line to explain how to begin. A
  // placeholder timestamp makes the largest control look unavailable.
  const timeLabel = $derived(
    looperState === 'empty'
      ? 'PRESS TO RECORD'
      : looperState === 'armed'
        ? 'PLAY TO START'
        : formatLoopSeconds(status.looperLengthSeconds),
  );
  const stoppable = $derived(animating);
</script>

<section
  class={[
    'flex h-full min-h-0 flex-col items-stretch gap-[.5rem] overflow-y-auto px-[.6rem] pt-2 pb-[.6rem]',
    looperState === 'empty' &&
      '[--looper-color:color-mix(in_srgb,var(--color-ink)_45%,transparent)]',
    looperState === 'armed' &&
      '[--looper-color:color-mix(in_srgb,var(--color-danger)_65%,transparent)]',
    looperState === 'recording' && '[--looper-color:var(--color-danger)]',
    looperState === 'playing' && '[--looper-color:var(--color-accent)]',
    looperState === 'overdubbing' && '[--looper-color:var(--color-hot)]',
    looperState === 'stopped' &&
      '[--looper-color:color-mix(in_srgb,var(--color-accent)_55%,transparent)]',
    // Maximized: fill the stage top to bottom — the pedal takes whatever height
    // the fixed-height button row leaves, so there is no dead band around it.
    // Same shape as the metronome's stage view, capped at the same width.
    large && 'mx-auto w-full max-w-176 gap-[.9rem] px-[1.4rem] pt-[1.2rem] pb-[1.6rem]',
  ]}
  aria-label="Looper"
>
  <!-- Simple is the default performance surface; Expert progressively reveals
       setup and archive-management controls without changing looper state. The
       switch itself rides in the panel header (ToolSidebar) — it is a panel
       depth, not a looper control, so it doesn't spend a row here. -->
  <!-- Everything the pedal can map lives inside MidiLearn, which also renders
       the learn switch at the foot of the panel. -->
  <MidiLearn
    {engine}
    {appSettings}
    {onSetAppSettings}
    {otherLearnActive}
    {large}
    divider={false}
    showControl={expert && !large}
    actions={LOOPER_ACTIONS}
    onApi={onLearnApi}
    bind:active={midiLearning}
    startTip="Map your MIDI pedal: click a looper button, then press its switch"
  >
    {#snippet children(learn)}
      <!-- The transport card: the pedal and the three verbs that act on what it
           captured, ruled off from each other but held in one surface. -->
      <!-- Stage view holds nothing but this group, so there is nothing to tell
           it apart from: the card's border and fill drop away and the pedal
           sits directly on the panel. -->
      <Card class={[large ? 'min-h-0 flex-1 border-0 bg-transparent' : 'flex-none']}>
        <!-- The one control that has to be hittable mid-song without aiming: the
           pedal's main switch, drawn as a pedal — big, round, state-coloured,
           with the playhead sweeping around it. -->
        <!-- The pedal keeps its own chrome, so it takes the ring skin rather than
           the edge one Button uses — same three states, drawn inside. -->
        {@const pedalLearn = learnStateOf(learn, 'looperToggle')}
        <button
          class={[
            // Rounded so the hover tint — and the learn outline, which follows
            // the radius — sit inside the card's corners rather than cutting
            // square across them.
            'flex w-full cursor-pointer flex-col items-center gap-[.35rem] rounded-control-md border-0 bg-transparent px-[.8rem] pt-[.7rem] pb-[.55rem] transition-colors duration-120 hover:bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            learnRingClass(pedalLearn),
            // A size container so the ring below can read the height it has
            // left (`cqh`) and take the larger of the two fits.
            large && '@container-size min-h-0 flex-1 justify-center',
          ]}
          aria-label={learn.on
            ? learn.tip('looperToggle', 'the main switch')
            : `Looper: ${stateLabel.toLowerCase()} — click to ${mainHint.toLowerCase()}`}
          onclick={() => (learn.on ? learn.click('looperToggle') : engine.looperCommand('toggle'))}
        >
          <!-- The idle ring is onboarding: it names the goal and the first
             action. Once active, the same space returns to state and time.
             Capped rather than full-bleed: the pedal keeps a margin inside its
             card, and the height it gives back goes to the session list. -->
          <!-- A container so the labels inside can size in `cqw` — the text then
               keeps its proportion to the ring at any zoom or window size. -->
          <!-- Maximized: as wide as the card allows, or as wide as the leftover
               height can carry (the ring is square, less the verb line under
               it) — whichever is smaller. Width still drives the layout, so the
               labels keep their proportion to the ring. -->
          <div
            class={[
              '@container relative mx-auto',
              large ? 'w-[min(100%,calc(100cqh-2.6rem))]' : 'w-full max-w-64',
            ]}
          >
            <svg
              class="block aspect-square h-auto w-full -rotate-90"
              viewBox="0 0 48 48"
              aria-hidden="true"
            >
              <circle
                class="fill-none stroke-control-edge [stroke-width:2.8]"
                cx="24"
                cy="24"
                r="21"
              />
              {#if looperState !== 'empty'}
                <circle
                  class="fill-none stroke-(--looper-color) [stroke-width:2.8] [stroke-linecap:round]"
                  cx="24"
                  cy="24"
                  r="21"
                  stroke-dasharray={CIRCUMFERENCE}
                  stroke-dashoffset={CIRCUMFERENCE * (1 - displayPosition)}
                />
              {/if}
            </svg>
            <div
              class="pointer-events-none absolute inset-0 flex items-center justify-center"
              role="status"
            >
              <!-- The state word alone is centred on the circle; the clock line hangs
                   below it so the word never shifts as the second line changes. -->
              <span
                class={[
                  'font-mono text-[12cqw] leading-none font-bold tracking-[.09em] text-(--looper-color)',
                  looperState === 'recording' &&
                    'animate-[looper-rec-pulse_1s_ease-in-out_infinite]',
                  looperState === 'armed' && 'animate-[looper-rec-pulse_1.8s_ease-in-out_infinite]',
                ]}>{stateLabel}</span
              >
              <span
                class={[
                  'absolute top-1/2 mt-[8cqw] font-mono text-[6.5cqw] leading-none',
                  looperState === 'empty'
                    ? 'font-bold tracking-[.04em] text-accent'
                    : 'font-medium text-[color-mix(in_srgb,var(--color-ink)_60%,transparent)] tabular-nums',
                ]}>{timeLabel}</span
              >
            </div>
          </div>
          {#if looperState === 'empty'}
            <span
              class={[
                'font-mono text-[.76rem] leading-normal font-medium text-[color-mix(in_srgb,var(--color-ink)_62%,transparent)]',
                large && 'text-[1.05rem]',
              ]}
            >
              {status.looperArmEnabled
                ? 'Starts on your first note'
                : 'Recording starts immediately'}
            </span>
          {:else}
            <span
              class={[
                'font-mono text-[.8rem] leading-normal font-[650] tracking-[.05em] text-[color-mix(in_srgb,var(--color-ink)_85%,transparent)]',
                large && 'text-[1.15rem]',
              ]}
              ><span class="font-medium text-[color-mix(in_srgb,var(--color-ink)_45%,transparent)]"
                >Next:</span
              >
              {mainVerb}</span
            >
          {/if}
        </button>

        <!-- In learn mode these stay clickable regardless of looper state: the
           click arms the mapping, it never runs the action. -->
        <div
          class={[
            'grid flex-none grid-cols-3 gap-[.35rem] p-[.4rem]',
            large && 'gap-[.5rem] p-[.55rem]',
          ]}
          role="group"
          aria-label="Looper actions"
        >
          <Button
            block
            size={large ? 'lg' : 'md'}
            learn={learnStateOf(learn, 'looperStop')}
            disabled={!learn.on && !stoppable}
            tip={learn.on ? learn.tip('looperStop', 'Stop') : 'Stop playback — the loop is kept'}
            tipPlacement="bottom"
            onclick={() => (learn.on ? learn.click('looperStop') : engine.looperCommand('stop'))}
          >
            Stop
          </Button>
          <Button
            block
            size={large ? 'lg' : 'md'}
            learn={learnStateOf(learn, 'looperClear')}
            disabled={!learn.on && looperState === 'empty'}
            tip={learn.on
              ? learn.tip('looperClear', 'Clear')
              : 'Clear the loop — it is archived under Sessions'}
            tipPlacement="bottom"
            onclick={() => (learn.on ? learn.click('looperClear') : engine.looperCommand('clear'))}
          >
            Clear
          </Button>
          <Button
            block
            size={large ? 'lg' : 'md'}
            learn={learnStateOf(learn, 'looperUndo')}
            disabled={!learn.on && !status.looperHasUndo}
            tip={learn.on
              ? learn.tip('looperUndo', 'Undo')
              : status.looperUndoIsRedo
                ? 'Bring the undone overdub back'
                : 'Undo the last overdub — the same button then redoes it'}
            tipPlacement="bottom"
            onclick={() => (learn.on ? learn.click('looperUndo') : engine.looperCommand('undo'))}
          >
            <!-- Undo is a swap, so the label tracks what the press will do. In
               learn mode it stays "Undo": the mapping is per action, not per
               direction. -->
            {learn.on || !status.looperUndoIsRedo ? 'Undo' : 'Redo'}
          </Button>
        </div>
      </Card>

      <!-- Stage view is the performance surface: nothing but the pedal and its
               three verbs. Setup, the archive and the learn switch all belong to
               the docked panel, where there is time to use them. -->
      {#if expert && !large}
        <!-- The wrapper is the transition's: Expert reveals this whole block, so
             it slides the panel open rather than snapping the sessions card
             down. Card itself is a component and cannot carry one. -->
        <div class="flex-none" transition:slide={reveal.slide()}>
          <!-- Setup, one row per decision, ruled off inside a single card. -->
          <Card>
            <!-- Where the looper taps the chain. Post is the live-looping default:
               the loop carries the full processed tone. Pre feeds the dry guitar
               back through the rig, so amp and effect tweaks apply to the loop. -->
            <CardRow label="Placement" class={[large && 'text-[.85rem]']}>
              <SegmentedControl
                label="Looper placement"
                value={status.looperPostChain}
                options={[
                  {
                    value: false,
                    label: 'Pre',
                    tip: 'Before the chain — loop the dry guitar into the rig',
                  },
                  {
                    value: true,
                    label: 'Post',
                    tip: 'After the chain — loop the full processed tone',
                  },
                ]}
                onSelect={(looperPostChain) => engine.setStatus({ looperPostChain })}
              />
            </CardRow>

            <!-- Auto-arm: whether Record waits for the first note. Off restores the
               classic press-and-it-rolls pedal behaviour. -->
            <CardRow label="Auto-arm" class={[large && 'text-[.85rem]']}>
              <SegmentedControl
                label="Auto-arm"
                value={status.looperArmEnabled}
                options={[
                  { value: true, label: 'On', tip: 'Record waits for your first note' },
                  { value: false, label: 'Off', tip: 'Record starts the moment you press' },
                ]}
                onSelect={(looperArmEnabled) => engine.setStatus({ looperArmEnabled })}
              />
            </CardRow>

            {#if status.looperArmEnabled}
              <!-- How loud "your first note" has to be. Low ignores a noisy rig's
                 hiss; High catches soft fingerpicking. -->
              <CardRow label="Sensitivity" class={[large && 'text-[.85rem]']}>
                <div class="flex items-center gap-[.35rem]">
                  <SegmentedControl
                    label="Arm trigger sensitivity"
                    value={status.looperArmThresholdDb}
                    options={SENSITIVITIES.map((option) => ({
                      value: option.db,
                      label: option.label,
                      tip: `Trigger at ${option.db} dBFS`,
                    }))}
                    onSelect={(looperArmThresholdDb) => engine.setStatus({ looperArmThresholdDb })}
                  />
                  <!-- Anything between the presets, in the engine's own unit. -->
                  <TextField
                    size="sm"
                    inputmode="numeric"
                    aria-label="Arm trigger threshold in dBFS"
                    title={`Trigger threshold, ${ARM_DB_MIN} to ${ARM_DB_MAX} dBFS`}
                    class="w-[2.9rem] text-right tabular-nums"
                    value={armDbText}
                    oninput={(e) => (armDbDraft = e.currentTarget.value)}
                    onblur={commitArmDb}
                    onkeydown={onEnterEscape(commitArmDb, () => (armDbDraft = null))}
                  />
                  <span class="text-(length:--ctl-text-xs) text-muted">dB</span>
                </div>
              </CardRow>
            {/if}
          </Card>
        </div>
      {/if}

      <!-- The session archive: Clear doesn't discard, it files the loop here.
               Click a row to bring one back (it lands stopped, ready for the pedal).
               Stage view drops it with the rest of the setup — see above. -->
      {#if !large}
        <LooperSessions {engine} {status} {appSettings} {onSetAppSettings} {expert} {large} />
      {/if}
    {/snippet}
  </MidiLearn>
</section>

<style>
  @keyframes looper-rec-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }
</style>
