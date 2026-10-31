<script lang="ts">
  import { ArrowCounterClockwiseIcon, PianoKeysIcon } from 'phosphor-svelte';
  import { fly, slide } from 'svelte/transition';
  import { describeTrigger } from '../../lib/engine/midi';
  import {
    NOISE_GATE_ATTACK_MS,
    NOISE_GATE_DEFAULT_SHAPE,
    NOISE_GATE_HOLD_MS,
    NOISE_GATE_RANGE_DB,
    NOISE_GATE_RELEASE_MS,
    NOISE_GATE_THRESHOLD_DB,
    formatMs,
    noiseGateShapeFromEngine,
    noiseGateShapeToEngine,
  } from '../../lib/engine/noiseGate';
  import type { SettableStatus } from '../../lib/engine/EngineBridge';
  import type { MidiTrigger, StatusState, ToolViewMode } from '../../lib/engine/types';
  import Button from '../../lib/components/Button.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import { cn } from '../../lib/components/classNames';
  import { createReveal } from '../../lib/components/reveal.svelte';

  /**
   * The GATE pill's slideout, built like the mute's: a drawer pulled out of
   * the bar, docked to its top edge, open while the pointer is in the zone.
   *
   * The threshold is the control that matters, so it is drawn over the live
   * input level: the fill is what the IN meter shows, on the threshold's own
   * scale, and the marker is where the gate opens — set it a few dB above
   * where the fill settles between notes and the job is done. That is Simple,
   * and for most rigs it is the whole job. Expert — the same panel-header
   * switch the looper and metronome carry — reveals, in the order a player
   * reaches for them: how the gate closes (shape), how fast it opens and
   * shuts (attack, hold, release) and how deep it goes (range), plus the
   * footswitch learn and a reset to the shipped settings. Hysteresis and the
   * detector stay fixed in the engine.
   */
  interface Props {
    status: StatusState;
    onSetStatus: (status: Partial<SettableStatus>) => void;
    /** Simple/Expert — persisted like the other tools' (settings.json). */
    viewMode: ToolViewMode;
    onSetViewMode: (mode: ToolViewMode) => void;
    /** The learned MIDI trigger that toggles the gate, if any. */
    midiBinding: MidiTrigger | undefined;
    midiLearning: boolean;
    onMidiLearnToggle: () => void;
    onMidiClear: () => void;
  }

  let {
    status,
    onSetStatus,
    viewMode,
    onSetViewMode,
    midiBinding,
    midiLearning,
    onMidiLearnToggle,
    onMidiClear,
  }: Props = $props();

  const expert = $derived(viewMode === 'expert');

  /** Centred on the GATE pill like the mute's panel is on its pill — but the
      pill sits near the window's left edge, so a centred 28rem panel can run
      off it. Measure once laid out and shift it just far enough back in. */
  function keepOnScreen(node: HTMLElement) {
    const fit = () => {
      node.style.setProperty('--shift', '0px');
      const rect = node.getBoundingClientRect();
      const margin = 8;
      const shift =
        rect.left < margin
          ? margin - rect.left
          : rect.right > window.innerWidth - margin
            ? window.innerWidth - margin - rect.right
            : 0;
      node.style.setProperty('--shift', `${shift}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }
  // Motion for what Expert reveals — see reveal.svelte.ts.
  const reveal = createReveal();

  const closed = $derived(status.noiseGateEnabled && !status.noiseGateOpen);
  const shape = $derived(noiseGateShapeFromEngine(status.noiseGateShape));
  const formatAttack = (ms: number) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  const fillWidth = (value: number, range: { min: number; max: number }) =>
    `${((value - range.min) / (range.max - range.min)) * 100}%`;

  // The input level on the threshold slider's scale, so fill and marker share
  // an axis. -60 is the IN meter's floor and sits a third of the way along here.
  const levelDb = $derived(
    status.inputPeak > 0.00001 ? Math.max(-120, 20 * Math.log10(status.inputPeak)) : -120,
  );
  const span = NOISE_GATE_THRESHOLD_DB.max - NOISE_GATE_THRESHOLD_DB.min;
  const fraction = (db: number) =>
    Math.max(0, Math.min(1, (db - NOISE_GATE_THRESHOLD_DB.min) / span));
  const levelFill = $derived(`${fraction(levelDb) * 100}%`);
  const thresholdPosition = $derived(`${fraction(status.noiseGateThresholdDb) * 100}%`);

  const sliderTrack =
    'relative h-[1.35rem] min-w-0 flex-1 overflow-hidden rounded-[.25rem] border border-[color:color-mix(in_srgb,var(--color-ink)_calc(14%_*_var(--ink-k)),transparent)] bg-well';
  const sliderInput = 'absolute inset-0 m-0 h-full w-full cursor-ew-resize opacity-0';
  const rowClass = 'flex items-center gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]';
  const captionClass =
    'w-[4.6rem] flex-none text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]';
  const valueClass =
    'w-[3.6rem] flex-none text-right text-[color:color-mix(in_srgb,var(--color-ink)_60%,transparent)] tabular-nums';
</script>

<div
  class="absolute bottom-full left-1/2 z-60 flex w-[28rem] max-w-[calc(100vw-1rem)] translate-x-[calc(-50%+var(--shift,0px))] flex-col gap-[.1rem] rounded-[.4rem_.4rem_0_0] border border-b-0 border-[color:color-mix(in_srgb,var(--color-ink)_calc(18%_*_var(--ink-k)),transparent)] bg-[color:var(--bar-surface)] px-[.4rem] py-[.35rem] font-mono text-[length:var(--footer-font-size)] font-[650] text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)] shadow-[0_-4px_14px_color-mix(in_srgb,var(--color-void)_20%,transparent)] backdrop-blur-2xl"
  transition:fly={{ y: 8, duration: 140 }}
  {@attach keepOnScreen}
>
  <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
    <span>Noise gate</span>
    <!-- Simple/Expert rides in the header, where the sidebar tools keep it: a
         panel-level switch that reveals rows rather than touching the gate. The
         gate's own on/off is the GATE pill this panel hangs from, so it is not
         repeated here. -->
    <SegmentedControl
      label="Noise gate view"
      value={viewMode}
      options={[
        { value: 'simple', label: 'Simple' },
        { value: 'expert', label: 'Expert' },
      ]}
      onSelect={onSetViewMode}
    />
  </div>

  <!-- Threshold over the live level. The fill is the IN meter's peak on this
       slider's scale; the marker is the threshold. The range input is the
       whole track, invisible, so a click anywhere lands the marker there. -->
  <label class={rowClass}>
    <span class={captionClass}>Threshold</span>
    <span class={sliderTrack} style={`--fill:${levelFill}; --mark:${thresholdPosition}`}>
      <span
        class={cn(
          'absolute inset-y-0 left-0 w-(--fill) bg-[color:color-mix(in_srgb,var(--color-ink)_38%,transparent)] [transition:width_70ms_linear]',
          closed && 'bg-[color:color-mix(in_srgb,var(--color-ink)_20%,transparent)]',
        )}
      ></span>
      <span
        class="pointer-events-none absolute top-0 bottom-0 left-(--mark) w-[.14rem] -translate-x-1/2 bg-ink shadow-[0_0_5px_color-mix(in_srgb,var(--color-ink)_45%,transparent)]"
        aria-hidden="true"
      ></span>
      <input
        class={sliderInput}
        type="range"
        min={NOISE_GATE_THRESHOLD_DB.min}
        max={NOISE_GATE_THRESHOLD_DB.max}
        step={NOISE_GATE_THRESHOLD_DB.step}
        aria-label="Noise gate threshold"
        aria-valuetext={`${status.noiseGateThresholdDb} dB`}
        value={status.noiseGateThresholdDb}
        oninput={(e) => onSetStatus({ noiseGateThresholdDb: Number(e.currentTarget.value) })}
      />
    </span>
    <span class={valueClass}>{status.noiseGateThresholdDb} dB</span>
  </label>

  {#if expert}
    <!-- The wrapper carries the reveal: Expert opens this whole block at once,
         sliding the panel taller rather than snapping five rows in. -->
    <div class="flex flex-col gap-[.1rem]" transition:slide={reveal.slide()}>
      <!-- Soft and firm ease a dying note out at a multiple of its own decay;
         hard is the classic gate, straight to the floor. Said as a choice of
         three rather than a ratio knob: nobody tunes an expansion ratio by ear
         between songs. -->
      <div class={rowClass}>
        <span class={captionClass}>Shape</span>
        <SegmentedControl
          label="Noise gate shape"
          value={shape}
          fill
          class="flex-1"
          options={[
            {
              value: 'soft',
              label: 'Soft',
              tip: 'Eases notes out gently; hum is quietened, not removed',
            },
            { value: 'firm', label: 'Firm', tip: 'Closes decisively, still fades a dying note' },
            {
              value: 'hard',
              label: 'Hard',
              tip: 'A classic gate: straight to the floor once closed',
            },
          ]}
          onSelect={(next) => onSetStatus({ noiseGateShape: noiseGateShapeToEngine(next) })}
        />
      </div>

      <label class={rowClass}>
        <span class={captionClass}>Attack</span>
        <span class={sliderTrack}>
          <span
            class="absolute inset-y-0 left-0 bg-[color:color-mix(in_srgb,var(--color-ink)_38%,transparent)]"
            style:width={fillWidth(status.noiseGateAttackMs, NOISE_GATE_ATTACK_MS)}
          ></span>
          <input
            class={sliderInput}
            type="range"
            min={NOISE_GATE_ATTACK_MS.min}
            max={NOISE_GATE_ATTACK_MS.max}
            step={NOISE_GATE_ATTACK_MS.step}
            aria-label="Noise gate attack"
            aria-valuetext={formatAttack(status.noiseGateAttackMs)}
            value={status.noiseGateAttackMs}
            oninput={(e) => onSetStatus({ noiseGateAttackMs: Number(e.currentTarget.value) })}
          />
        </span>
        <span class={valueClass}>{formatAttack(status.noiseGateAttackMs)}</span>
      </label>

      <label class={rowClass}>
        <span class={captionClass}>Hold</span>
        <span class={sliderTrack}>
          <span
            class="absolute inset-y-0 left-0 bg-[color:color-mix(in_srgb,var(--color-ink)_38%,transparent)]"
            style:width={`${((status.noiseGateHoldMs - NOISE_GATE_HOLD_MS.min) / (NOISE_GATE_HOLD_MS.max - NOISE_GATE_HOLD_MS.min)) * 100}%`}
          ></span>
          <input
            class={sliderInput}
            type="range"
            min={NOISE_GATE_HOLD_MS.min}
            max={NOISE_GATE_HOLD_MS.max}
            step={NOISE_GATE_HOLD_MS.step}
            aria-label="Noise gate hold"
            aria-valuetext={formatMs(status.noiseGateHoldMs)}
            value={status.noiseGateHoldMs}
            oninput={(e) => onSetStatus({ noiseGateHoldMs: Number(e.currentTarget.value) })}
          />
        </span>
        <span class={valueClass}>{formatMs(status.noiseGateHoldMs)}</span>
      </label>

      <label class={rowClass}>
        <span class={captionClass}>Release</span>
        <span class={sliderTrack}>
          <span
            class="absolute inset-y-0 left-0 bg-[color:color-mix(in_srgb,var(--color-ink)_38%,transparent)]"
            style:width={`${((status.noiseGateReleaseMs - NOISE_GATE_RELEASE_MS.min) / (NOISE_GATE_RELEASE_MS.max - NOISE_GATE_RELEASE_MS.min)) * 100}%`}
          ></span>
          <input
            class={sliderInput}
            type="range"
            min={NOISE_GATE_RELEASE_MS.min}
            max={NOISE_GATE_RELEASE_MS.max}
            step={NOISE_GATE_RELEASE_MS.step}
            aria-label="Noise gate release"
            aria-valuetext={formatMs(status.noiseGateReleaseMs)}
            value={status.noiseGateReleaseMs}
            oninput={(e) => onSetStatus({ noiseGateReleaseMs: Number(e.currentTarget.value) })}
          />
        </span>
        <span class={valueClass}>{formatMs(status.noiseGateReleaseMs)}</span>
      </label>

      <label class={rowClass}>
        <span class={captionClass}>Range</span>
        <span class={sliderTrack}>
          <span
            class="absolute inset-y-0 left-0 bg-[color:color-mix(in_srgb,var(--color-ink)_38%,transparent)]"
            style:width={fillWidth(status.noiseGateRangeDb, NOISE_GATE_RANGE_DB)}
          ></span>
          <input
            class={sliderInput}
            type="range"
            min={NOISE_GATE_RANGE_DB.min}
            max={NOISE_GATE_RANGE_DB.max}
            step={NOISE_GATE_RANGE_DB.step}
            aria-label="Noise gate range"
            aria-valuetext={`${status.noiseGateRangeDb} dB`}
            value={status.noiseGateRangeDb}
            oninput={(e) => onSetStatus({ noiseGateRangeDb: Number(e.currentTarget.value) })}
          />
        </span>
        <span class={valueClass}>−{status.noiseGateRangeDb} dB</span>
      </label>

      <!-- The gate's footswitch, learned here beside the thing it toggles, the
           mute's arrangement. -->
      <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
        <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Switch</span>
        <Button
          size="sm"
          tone={midiLearning ? 'accent' : 'neutral'}
          learn={midiLearning ? 'armed' : midiBinding ? 'bound' : 'off'}
          aria-pressed={midiLearning}
          aria-label={midiBinding
            ? "Clear the noise gate's MIDI binding"
            : 'Learn a MIDI trigger for the noise gate'}
          onclick={() => (midiBinding ? onMidiClear() : onMidiLearnToggle())}
          tip={midiBinding
            ? 'Click to clear the gate’s MIDI trigger'
            : midiLearning
              ? 'Listening — press a switch'
              : 'Click, then press the switch that should toggle the gate'}
          tipPlacement="top"
        >
          <PianoKeysIcon size={14} weight={midiBinding ? 'fill' : 'regular'} aria-hidden="true" />
          <span role="status"
            >{midiBinding
              ? describeTrigger(midiBinding)
              : midiLearning
                ? 'Press a switch'
                : 'MIDI learn'}</span
          >
        </Button>
      </div>

      <!-- Back to the shipped settings, for a gate that has been dialled into a
           corner. The threshold goes too: it is the one most often moved and
           the one most often wrong. Expert only, like everything it resets. -->
      <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
        <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Reset</span>
        <Button
          size="sm"
          aria-label="Reset the noise gate to its default settings"
          tip="Threshold, shape, attack, hold, release and range back to their defaults"
          tipPlacement="top"
          onclick={() =>
            onSetStatus({
              noiseGateThresholdDb: NOISE_GATE_THRESHOLD_DB.default,
              noiseGateShape: noiseGateShapeToEngine(NOISE_GATE_DEFAULT_SHAPE),
              noiseGateAttackMs: NOISE_GATE_ATTACK_MS.default,
              noiseGateHoldMs: NOISE_GATE_HOLD_MS.default,
              noiseGateReleaseMs: NOISE_GATE_RELEASE_MS.default,
              noiseGateRangeDb: NOISE_GATE_RANGE_DB.default,
            })}
        >
          <ArrowCounterClockwiseIcon size={14} aria-hidden="true" />
          Defaults
        </Button>
      </div>
    </div>
  {/if}
</div>
