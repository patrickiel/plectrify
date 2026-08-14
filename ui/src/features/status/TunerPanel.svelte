<script lang="ts">
  import { PianoKeysIcon } from 'phosphor-svelte';
  import { fly } from 'svelte/transition';
  import { NEEDLE_PRECISIONS, STROBE_PRECISIONS } from '../../lib/engine/appSettings';
  import { describeTrigger } from '../../lib/engine/midi';
  import type {
    MidiTrigger,
    NeedlePrecision,
    StrobePrecision,
    TunerDisplayMode,
  } from '../../lib/engine/types';
  import { cn } from '../../lib/components/classNames';
  import { learnBadgeClass } from '../../lib/components/learnSkin';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';

  interface Props {
    display: TunerDisplayMode;
    strobePrecision: StrobePrecision;
    needlePrecision: NeedlePrecision;
    /** True when the system asks for reduced motion, which suppresses the strobe
        without discarding the preference. */
    reduceMotion: boolean;
    /** The learned MIDI trigger that toggles the tuner, if any. Learned here,
        beside the readout it toggles, rather than in the MIDI dialog. */
    midiBinding: MidiTrigger | undefined;
    midiLearning: boolean;
    /** True while the full-size stage tuner is up over the rack. */
    fullSizeActive: boolean;
    onSetDisplay: (display: TunerDisplayMode) => void;
    onSetStrobePrecision: (precision: StrobePrecision) => void;
    onSetNeedlePrecision: (precision: NeedlePrecision) => void;
    onToggleFullSize: () => void;
    onMidiLearnToggle: () => void;
    onMidiClear: () => void;
  }

  let {
    display,
    strobePrecision,
    needlePrecision,
    reduceMotion,
    midiBinding,
    midiLearning,
    fullSizeActive,
    onSetDisplay,
    onSetStrobePrecision,
    onSetNeedlePrecision,
    onToggleFullSize,
    onMidiLearnToggle,
    onMidiClear,
  }: Props = $props();
</script>

<!-- The tuner's slideout: a drawer pulled out of the bar, not a card hovering
     over it. It borrows the bar's own surface and docks flush to its top edge —
     flush also means there is no gap to cross on the way in, so the pointer never
     leaves the zone and the panel needs no bridge to survive the trip.

     Settings only. The readout itself lives in the bar, where it is visible
     without a hover — so this drawer holds nothing that has to be watched. -->
<div
  class="absolute right-0 bottom-full left-0 z-60 mx-auto flex w-max flex-col gap-[.1rem] rounded-[.4rem_.4rem_0_0] border border-b-0 border-[color:color-mix(in_srgb,var(--color-ink)_calc(18%_*_var(--ink-k)),transparent)] bg-[color:var(--bar-surface)] px-[.4rem] py-[.35rem] font-mono text-[length:var(--footer-font-size)] font-[650] text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)] shadow-[0_-4px_14px_color-mix(in_srgb,var(--color-void)_20%,transparent)] backdrop-blur-2xl"
  transition:fly={{ y: 8, duration: 140 }}
>
  <!-- A segmented control rather than a checkbox: the readouts are named
       alternatives, and a checkbox would leave that mutual exclusivity implicit.
       It lives here, beside the display it changes, rather than in the setup menu
       where the theme sits — a theme is set once for a room, but which readout
       you want is something you flip while looking at the tuner. -->
  <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
    <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Display</span>
    <SegmentedControl
      label="Tuner display"
      value={display}
      options={[
        { value: 'needle', label: 'Needle' },
        { value: 'strobe', label: 'Strobe' },
      ]}
      onSelect={onSetDisplay}
    />
  </div>

  {#if display === 'strobe'}
    <!-- One number, because there is only one real choice to make: how fine the
         rows are. The second row is always four times the first, so naming the
         first names the pair. Higher resolves more but drifts faster, and idles
         itself on the upper strings once it would only be showing noise. -->
    <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
      <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Precision</span
      >
      <SegmentedControl
        label="Strobe precision"
        value={strobePrecision}
        options={STROBE_PRECISIONS.map((option) => ({ value: option, label: `×${option}` }))}
        onSelect={onSetStrobePrecision}
      />
    </div>
  {/if}

  {#if display === 'needle'}
    <!-- The strobe's ×1/×2/×4 vocabulary, but here the number magnifies the
         middle of the scale: the needle still covers ±50c edge to edge, and
         higher settings spend the width on the last few cents — where tuning
         actually happens — instead of the forty that are already obviously
         wrong. ×1 is the plain linear scale. -->
    <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
      <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Precision</span
      >
      <SegmentedControl
        label="Needle precision"
        value={needlePrecision}
        options={NEEDLE_PRECISIONS.map((option) => ({ value: option, label: `×${option}` }))}
        onSelect={onSetNeedlePrecision}
      />
    </div>
  {/if}

  {#if display === 'strobe' && reduceMotion}
    <!-- A strobe *is* motion: frozen it is only a worse needle, and stepped it
         is more provocative, not less. So the preference is kept and the needle
         shown, rather than the choice being taken away. -->
    <p
      class="max-w-full px-[.35rem] pb-[.1rem] font-sans text-[.68rem] leading-[1.35] font-medium text-muted"
    >
      Showing the needle — your system asks for reduced motion.
    </p>
  {/if}

  <!-- The stage tuner, raised from here as well as from a footswitch — a pedal
       is how you reach it mid-song, but it should never be the only way in.
       Its MIDI binding sits on the same row, beside the thing it triggers,
       rather than in the MIDI dialog: the icon is the same clear-first control
       used by knobs, modules and lanes, and its tooltip carries the detail. -->
  <div class="flex items-center justify-between gap-3 py-[.1rem] pr-[.1rem] pl-[.35rem]">
    <span class="text-[color:color-mix(in_srgb,var(--color-ink)_80%,transparent)]">Full size</span>
    <div class="flex items-center gap-[.3rem]">
      <SegmentedControl
        label="Full-size tuner"
        value={fullSizeActive}
        options={[
          {
            value: true,
            label: 'Show',
            tip: fullSizeActive
              ? 'Hide the full-size tuner'
              : 'Show the full-size tuner over the rack',
          },
        ]}
        onSelect={() => onToggleFullSize()}
      />
      <button
        type="button"
        class={cn(
          'grid h-[1.55rem] w-7 cursor-pointer place-items-center rounded-[.3rem] border border-[color:color-mix(in_srgb,var(--color-ink)_calc(22%_*_var(--ink-k)),transparent)] bg-transparent p-0 text-[color:color-mix(in_srgb,var(--color-ink)_75%,transparent)] [transition:color_120ms_ease,border-color_120ms_ease,background-color_120ms_ease] hover:bg-ink/7 hover:text-ink focus-visible:bg-ink/7 focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent motion-reduce:transition-none',
          learnBadgeClass(midiLearning ? 'armed' : midiBinding ? 'bound' : 'off'),
        )}
        aria-pressed={midiLearning}
        aria-label={midiBinding
          ? "Clear the tuner's MIDI binding"
          : 'Learn a MIDI trigger for the tuner'}
        onclick={() => (midiBinding ? onMidiClear() : onMidiLearnToggle())}
        {@attach tooltip(
          midiBinding
            ? `${describeTrigger(midiBinding)} — click to clear`
            : midiLearning
              ? 'Listening — press a switch'
              : 'Learn MIDI tuner trigger',
          { placement: 'right' },
        )}
      >
        <PianoKeysIcon size={14} weight={midiBinding ? 'fill' : 'regular'} aria-hidden="true" />
      </button>
    </div>
  </div>
</div>
