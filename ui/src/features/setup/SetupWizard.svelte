<script lang="ts">
  import {
    ArrowClockwiseIcon,
    CaretLeftIcon,
    CaretRightIcon,
    CheckCircleIcon,
    PlugIcon,
    SpeakerHighIcon,
    WarningIcon,
  } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { AppInfo, AudioDevicesState, StatusState } from '../../lib/engine/types';
  import { EMPTY_AUDIO_DEVICES } from '../../lib/engine/types';
  import { betterDriverAvailable, devicesOf } from '../../lib/engine/audioDevices';
  import { onMount } from 'svelte';
  import Button from '../../lib/components/Button.svelte';
  import DialogShell from '../../lib/components/DialogShell.svelte';
  import Select from '../../lib/components/Select.svelte';
  import { cn } from '../../lib/components/classNames';
  import { accumulatePeaks, detectInputChannel, meterFill } from './inputDetect';
  import { describeBufferSize, describeLatency, formatMs, latencyMilliseconds } from './latency';

  /**
   * First-run audio setup, in the order a guitarist can answer it: which
   * interface, which jack, how much latency.
   *
   * This exists because the audio device is the one thing standing between
   * installing Plectrify and hearing a guitar, and the native
   * AudioDeviceSelectorComponent asks for all of it at once, in driver
   * vocabulary, in a grey OS dialog. Four questions — driver family, device,
   * channel mask, block size — every one of which is answerable only by someone
   * who already knows the answer.
   *
   * The step that earns the whole thing is the second one. "Which input is your
   * guitar in?" is unanswerable by anyone: interfaces number their jacks from 1
   * and their drivers from 0, and getting it wrong is silence with nothing on
   * screen to explain it. So it is not asked — the engine meters every input
   * channel, the player strums, and the wizard says which jack it heard.
   *
   * Nothing here is compulsory. Every step can be skipped, the whole thing can
   * be dismissed, and Settings keeps a way back to it — a wizard that traps
   * someone who already knows their rig is worse than no wizard.
   */
  interface Props {
    engine: EngineBridge;
    /** The live status stream, for the round-trip latency readout. */
    status: StatusState;
    appInfo: AppInfo;
    /** True while the engine is fetching the starter bundle by itself, so the
        last step can account for the download rather than leaving the user on
        an empty rack wondering. */
    starterInstalling: boolean;
    /** Finished, or waved away — the caller records it either way. */
    onDone: () => void;
  }

  let { engine, status, appInfo, starterInstalling, onDone }: Props = $props();

  type Step = 'device' | 'input' | 'latency' | 'ready';
  const STEPS: readonly Step[] = ['device', 'input', 'latency', 'ready'];
  const STEP_TITLES: Record<Step, string> = {
    device: 'Select your interface',
    input: 'Plug in and play',
    latency: 'Set the latency',
    ready: "You're set up",
  };

  let step = $state<Step>('device');
  let devices = $state<AudioDevicesState>(EMPTY_AUDIO_DEVICES);
  let rescanning = $state(false);

  /** Each input channel's loudest peak since this step last started listening.
      A running maximum, not a live level: a strum is one moment and the engine
      polls 15 times a second, so a rule reading the current frame would answer
      during the silence between two chords. */
  let maxima = $state<number[]>([]);
  /** The channel the step has settled on — heard, or picked by hand. Null until
      one of those has happened, which is what the step is waiting for. */
  let chosen = $state<number | null>(null);

  const stepIndex = $derived(STEPS.indexOf(step));
  const driver = $derived(devices.drivers.find((d) => d.name === devices.driver));
  const separateEnds = $derived(driver?.separateInputsAndOutputs === true);
  const roundTripMs = $derived(latencyMilliseconds(status.totalLatencySamples, status.sampleRate));
  // Only ever ASIO, and only on Windows — see betterDriverAvailable.
  const betterDriver = $derived(betterDriverAvailable(devices));
  const noAsioAtAll = $derived(
    appInfo.platform !== 'macos' && !devices.drivers.some((d) => d.name.toUpperCase() === 'ASIO'),
  );

  const asOptions = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

  const bufferOptions = $derived(
    devices.bufferSizes.map((size) => ({
      value: String(size),
      label:
        size === devices.recommendedBufferSize
          ? `${describeBufferSize(size, devices.sampleRate)} · recommended`
          : describeBufferSize(size, devices.sampleRate),
    })),
  );

  // onMount rather than $effect: the engine is fixed for this component's
  // lifetime, so there is nothing to react to — the returned unsubscribes are
  // the teardown.
  onMount(() => {
    const offAudio = engine.subscribeAudioDevices((state) => {
      devices = state;
      rescanning = false;
    });
    const offLevels = engine.subscribeInputLevels(onInputLevels);
    // A full re-enumeration once, when the wizard opens: on Windows this loads
    // every installed ASIO driver, which is exactly the slow thing that must
    // not happen on a push nobody asked for — and exactly what has to happen
    // before the list can name an interface plugged in five minutes ago.
    engine.refreshAudioDevices(true);
    rescanning = true;
    return () => {
      offAudio();
      offLevels();
    };
  });

  // Metering is a second tap of the raw device input and costs a scan of every
  // channel per block, so it is armed for exactly as long as something is
  // showing it — and dropped when the wizard closes, whichever way it closes.
  $effect(() => {
    const listening = step === 'input';
    engine.watchInputLevels(listening);
    return () => engine.watchInputLevels(false);
  });

  function onInputLevels(peaks: number[]) {
    maxima = accumulatePeaks(maxima, peaks);
    if (chosen !== null) return;

    const heard = detectInputChannel(maxima);
    if (heard !== null) chooseChannel(heard);
  }

  /** Commit the channel as soon as it is known, rather than on Next. The rig
      comes alive under the player's hands at the moment the wizard says it
      heard them, which is the whole reward for this step. */
  function chooseChannel(channel: number) {
    chosen = channel;
    engine.setAudioDevice({ inputChannel: channel });
  }

  /** A different device is a different set of jacks, so everything heard about
      the old one is about a channel list that no longer exists. */
  function forgetWhatWasHeard() {
    maxima = [];
    chosen = null;
  }

  function setDriver(name: string) {
    forgetWhatWasHeard();
    engine.setAudioDevice({ driver: name });
  }

  function setOutputDevice(name: string) {
    forgetWhatWasHeard();
    // A family with one device for both ends is answering both questions here,
    // and saying so keeps the engine from opening a mismatched pair.
    engine.setAudioDevice(
      separateEnds ? { outputDevice: name } : { outputDevice: name, inputDevice: name },
    );
  }

  function rescan() {
    rescanning = true;
    engine.refreshAudioDevices(true);
  }

  function goBack() {
    if (stepIndex > 0) step = STEPS[stepIndex - 1];
  }

  function goNext() {
    if (step === 'ready') {
      onDone();
      return;
    }
    step = STEPS[stepIndex + 1];
  }

  const channelName = (channel: number) => devices.inputChannels[channel] ?? `Input ${channel + 1}`;
</script>

<DialogShell
  labelledBy="setup-wizard-title"
  describedBy="setup-wizard-subtitle"
  onDismiss={onDone}
  dismissLabel="Skip setup"
  showCloseX
  cardClass="max-w-xl"
>
  <div class="px-7 pt-7 pb-6">
    <!-- Where you are, in four bars. Not a percentage: the steps are named
         questions, and the point is that there are only four of them. The right
         padding is DialogShell's close button, which sits over this row. -->
    <div class="flex items-center gap-[.3rem] pr-7" aria-hidden="true">
      {#each STEPS as name, index (name)}
        <span
          class={cn(
            'h-[.2rem] flex-1 rounded-full transition-colors duration-300',
            index <= stepIndex ? 'bg-accent' : 'bg-ink/10',
          )}
        ></span>
      {/each}
    </div>

    <p
      class="mt-5 font-mono text-[10px] tracking-[0.22em] text-accent uppercase"
      id="setup-wizard-subtitle"
    >
      Step {stepIndex + 1} of {STEPS.length}
    </p>
    <h2 id="setup-wizard-title" class="mt-1 text-lg font-semibold text-ink">
      {STEP_TITLES[step]}
    </h2>

    <div class="mt-5 min-h-[15rem]">
      {#if step === 'device'}
        <p class="text-sm leading-6 text-muted">The interface your guitar is plugged into.</p>

        <div class="mt-4 flex flex-col gap-3">
          {#if devices.drivers.length > 1}
            <label class="flex items-center justify-between gap-3 text-[.82rem] text-ink">
              <span class="font-medium">Driver</span>
              <Select
                options={asOptions(devices.drivers.map((d) => d.name))}
                value={devices.driver}
                filterable={false}
                size="sm"
                variant="plain"
                class="h-[1.9rem] min-w-[13rem]"
                aria-label="Audio driver"
                onSelect={setDriver}
              />
            </label>
          {/if}

          <label class="flex items-center justify-between gap-3 text-[.82rem] text-ink">
            <span class="font-medium">{separateEnds ? 'Output' : 'Interface'}</span>
            <Select
              options={asOptions(devicesOf(driver, 'output'))}
              value={devices.outputDevice}
              placeholder="No device"
              filterable={false}
              size="sm"
              variant="plain"
              class="h-[1.9rem] min-w-[13rem]"
              aria-label={separateEnds ? 'Output device' : 'Audio interface'}
              onSelect={setOutputDevice}
            />
          </label>

          {#if separateEnds}
            <label class="flex items-center justify-between gap-3 text-[.82rem] text-ink">
              <span class="font-medium">Input</span>
              <Select
                options={asOptions(devicesOf(driver, 'input'))}
                value={devices.inputDevice}
                placeholder="No device"
                filterable={false}
                size="sm"
                variant="plain"
                class="h-[1.9rem] min-w-[13rem]"
                aria-label="Input device"
                onSelect={(name) => {
                  forgetWhatWasHeard();
                  engine.setAudioDevice({ inputDevice: name });
                }}
              />
            </label>
          {/if}
        </div>

        <div class="mt-4 flex items-start gap-2 text-[.78rem] leading-[1.45]">
          {#if !devices.open}
            <WarningIcon class="mt-[.1rem] shrink-0 text-hot" size={15} aria-hidden="true" />
            <p class="text-ink">
              That device won't open. Close other audio software, or pick another.
            </p>
          {:else if betterDriver}
            <SpeakerHighIcon class="mt-[.1rem] shrink-0 text-accent" size={15} aria-hidden="true" />
            <p class="text-muted">
              <button
                type="button"
                class="cursor-pointer font-medium text-accent underline underline-offset-2"
                onclick={() => setDriver(betterDriver)}>Switch to {betterDriver}</button
              > — it talks to your interface directly, with far less delay.
            </p>
          {:else if noAsioAtAll}
            <SpeakerHighIcon class="mt-[.1rem] shrink-0 text-muted" size={15} aria-hidden="true" />
            <p class="text-muted">
              Windows Audio is shared with the whole system. An ASIO driver, if your interface has
              one, is the biggest latency win.
            </p>
          {/if}
        </div>
      {:else if step === 'input'}
        <p class="text-sm leading-6 text-muted">
          Play a few notes. The meter that moves is your jack.
        </p>

        <div class="mt-4 flex flex-col gap-[.3rem]">
          {#each devices.inputChannels as name, channel (channel)}
            {@const level = meterFill(maxima[channel] ?? 0)}
            <button
              type="button"
              class={cn(
                'flex cursor-pointer items-center gap-3 rounded-[.35rem] border px-[.6rem] py-[.4rem] text-left transition-colors',
                chosen === channel
                  ? 'border-accent bg-accent/8'
                  : 'border-transparent hover:bg-ink/5',
              )}
              aria-pressed={chosen === channel}
              onclick={() => chooseChannel(channel)}
            >
              <span class="w-[7rem] shrink-0 truncate text-[.8rem] font-medium text-ink"
                >{name}</span
              >
              <span class="relative h-[.35rem] flex-1 rounded-full bg-ink/10">
                <span
                  class="absolute inset-y-0 left-0 rounded-[inherit] bg-accent [transition:width_90ms_linear]"
                  style:width={`${level * 100}%`}
                ></span>
              </span>
              {#if chosen === channel}
                <CheckCircleIcon class="shrink-0 text-accent" size={16} weight="fill" />
              {/if}
            </button>
          {:else}
            <p class="text-[.8rem] text-muted">
              No inputs on this device. Go back and pick another.
            </p>
          {/each}
        </div>

        <div class="mt-4 flex items-start gap-2 text-[.78rem] leading-[1.45]">
          {#if chosen !== null}
            <PlugIcon class="mt-[.1rem] shrink-0 text-accent" size={15} aria-hidden="true" />
            <p class="text-ink">
              Heard you on <strong class="font-semibold">{channelName(chosen)}</strong> — that's live
              now. Pick another row to change it.
            </p>
          {:else if devices.inputChannels.length > 0}
            <PlugIcon class="mt-[.1rem] shrink-0 text-muted" size={15} aria-hidden="true" />
            <p class="text-muted">
              Listening… nothing yet. Check the cable and volume, or pick a row.
            </p>
          {/if}
        </div>
      {:else if step === 'latency'}
        <p class="text-sm leading-6 text-muted">
          Smaller is faster, but can crackle. Play while you change it.
        </p>

        <div class="mt-4 flex items-center justify-between gap-3 text-[.82rem] text-ink">
          <span class="font-medium">Buffer size</span>
          <Select
            options={bufferOptions}
            value={String(devices.bufferSize)}
            placeholder="No device"
            filterable={false}
            size="sm"
            variant="plain"
            class="h-[1.9rem] min-w-[13rem]"
            aria-label="Buffer size"
            onSelect={(value) => engine.setAudioDevice({ bufferSize: Number(value) })}
          />
        </div>

        <div
          class="mt-5 rounded-[.4rem] border border-ink/12 bg-ink/4 px-[.8rem] py-[.7rem] text-center"
        >
          <p class="font-mono text-[10px] tracking-[0.22em] text-muted uppercase">Round trip</p>
          <p class="mt-1 font-mono text-2xl font-bold text-ink tabular-nums">
            {roundTripMs > 0 ? `${formatMs(roundTripMs)} ms` : '—'}
          </p>
          <p class="mt-1 text-[.78rem] leading-[1.4] text-muted">
            {roundTripMs > 0 ? describeLatency(roundTripMs) : 'No device open.'}
          </p>
        </div>
      {:else}
        <p class="text-sm leading-6 text-muted">
          {starterInstalling
            ? 'Starter pedals are still downloading. They will appear as they land.'
            : 'Drop an amp or pedal onto the rack and play. Change any of this in Settings.'}
        </p>

        <dl class="mt-5 flex flex-col gap-[.35rem] text-[.8rem]">
          {#snippet summary(label: string, value: string)}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-muted">{label}</dt>
              <dd class="truncate font-medium text-ink">{value}</dd>
            </div>
          {/snippet}
          {@render summary('Interface', devices.outputDevice || '—')}
          {@render summary('Driver', devices.driver || '—')}
          {@render summary(
            'Guitar input',
            devices.inputChannels.length > 0 ? channelName(devices.inputChannel) : '—',
          )}
          {@render summary(
            'Latency',
            roundTripMs > 0 ? `${formatMs(roundTripMs)} ms round trip` : '—',
          )}
        </dl>
      {/if}
    </div>

    <div class="mt-6 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        {#if stepIndex > 0}
          <Button variant="ghost" size="sm" onclick={goBack}>
            <CaretLeftIcon size={13} aria-hidden="true" />
            Back
          </Button>
        {/if}
        {#if step === 'device'}
          <Button variant="ghost" size="sm" onclick={rescan} disabled={rescanning}>
            <ArrowClockwiseIcon size={13} aria-hidden="true" />
            {rescanning ? 'Looking…' : 'Rescan'}
          </Button>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <!-- Always available, at every step: someone who already knows their rig
             must not have to walk through four screens to reach it. -->
        <Button variant="link" size="sm" onclick={onDone}>
          {step === 'ready' ? 'Close' : 'Skip setup'}
        </Button>
        <Button size="sm" tone="accent" onclick={goNext}>
          {#if step === 'ready'}
            Start playing
          {:else}
            Next
            <CaretRightIcon size={13} aria-hidden="true" />
          {/if}
        </Button>
      </div>
    </div>
  </div>
</DialogShell>
