<script lang="ts">
  import { PianoKeysIcon } from 'phosphor-svelte';
  import { fly } from 'svelte/transition';
  import { describeTrigger } from '../../lib/engine/midi';
  import type { MidiTrigger } from '../../lib/engine/types';
  import Button from '../../lib/components/Button.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';

  /**
   * The mute pill's slideout, built like the tuner's: a drawer pulled out of the
   * bar rather than a card hovering over it, docked flush to its top edge so the
   * pointer never leaves the zone on the way in.
   *
   * It holds the mute's MIDI binding and the feedback guard's on/off, with the
   * sentence explaining what that buys — the pill itself had only a tooltip,
   * which is the wrong place for a safety feature nobody sees working until the
   * day it fires. The mute button stays outside, in the bar, because it has to
   * be reachable without a hover; only its footswitch mapping lives in here,
   * beside the thing it triggers, the way the tuner's does.
   */
  interface Props {
    /** The persisted preference: is the guard watching? */
    enabled: boolean;
    /** The latch: is it holding the output muted right now? */
    tripped: boolean;
    onToggle: (enabled: boolean) => void;
    /** The learned MIDI trigger that toggles the mute, if any. */
    midiBinding: MidiTrigger | undefined;
    midiLearning: boolean;
    onMidiLearnToggle: () => void;
    onMidiClear: () => void;
  }

  let {
    enabled,
    tripped,
    onToggle,
    midiBinding,
    midiLearning,
    onMidiLearnToggle,
    onMidiClear,
  }: Props = $props();
</script>

<div
  class="absolute bottom-full left-1/2 z-60 flex w-max max-w-[19rem] -translate-x-1/2 flex-col gap-[.1rem] rounded-[.4rem_.4rem_0_0] border border-b-0 border-[color:color-mix(in_srgb,var(--color-ink)_calc(18%_*_var(--ink-k)),transparent)] bg-[color:var(--bar-surface)] px-[.4rem] py-[.35rem] font-mono text-[length:var(--footer-font-size)] font-[650] text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)] shadow-[0_-4px_14px_color-mix(in_srgb,var(--color-void)_20%,transparent)] backdrop-blur-2xl"
  transition:fly={{ y: 8, duration: 140 }}
>
  <!-- The mute's footswitch, learned here rather than in the MIDI dialog. The
       tools' own switch is the model, down to the wording: the button says what
       to do next rather than what it is, so an unlabelled key icon is not left
       carrying the whole instruction in a tooltip. A mute is the one control a
       player wants under a foot, so the press is honoured wherever it lands:
       nothing on screen gates it. -->
  <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
    <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Mute</span>
    <Button
      size="sm"
      tone={midiLearning ? 'accent' : 'neutral'}
      learn={midiLearning ? 'armed' : midiBinding ? 'bound' : 'off'}
      aria-pressed={midiLearning}
      aria-label={midiBinding
        ? "Clear the mute's MIDI binding"
        : 'Learn a MIDI trigger for the mute'}
      onclick={() => (midiBinding ? onMidiClear() : onMidiLearnToggle())}
      tip={midiBinding
        ? 'Click to clear the mute’s MIDI trigger'
        : midiLearning
          ? 'Listening — press a switch'
          : 'Click, then press the switch that should mute the output'}
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

  <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
    <span
      class="flex items-center gap-[.3rem] text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]"
    >
      Feedback protection
      <!-- The detector is still being tuned against real rigs, and it is off by
           default until it is not. Said as a badge rather than a sentence: it
           qualifies the switch, and the paragraph below is already the
           explanation. -->
      <span
        class="rounded-[.2rem] bg-[color:color-mix(in_srgb,var(--color-ink)_calc(12%_*_var(--ink-k)),transparent)] px-[.25rem] py-[.05rem] text-[.6rem] font-[650] tracking-wide text-muted uppercase"
        >Beta</span
      >
    </span>
    <SegmentedControl
      label="Feedback protection"
      value={enabled}
      options={[
        { value: true, label: 'On' },
        { value: false, label: 'Off' },
      ]}
      onSelect={onToggle}
    />
  </div>

  <!-- What it actually listens for, in one sentence: not loudness — a squeal
       can sit well below clipping — but a level that refuses to die away.
       Worth the words here, where there is room for them, because the guard is
       invisible until the day it fires. -->
  <p class="max-w-full px-[.35rem] pb-[.1rem] font-sans text-[.68rem] leading-[1.35] text-muted">
    Mutes the output when a level holds steady instead of dying away — how a feedback loop behaves
    and a played note never does. Unmuting is yours: turn something down, then press MUTE.
  </p>

  {#if tripped}
    <p
      class="max-w-full px-[.35rem] pb-[.1rem] font-sans text-[.68rem] leading-[1.35] font-semibold text-danger"
    >
      Feedback detected — the output is muted right now.
    </p>
  {/if}
</div>
