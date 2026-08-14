<script lang="ts">
  import type { AppSettings, TunerReading } from '../../lib/engine/types';
  import TunerReadout from './TunerReadout.svelte';

  interface Props {
    reading: TunerReading;
    settings: Pick<AppSettings, 'tunerDisplay' | 'tunerStrobePrecision' | 'tunerNeedlePrecision'>;
    reduceMotion: boolean;
    /** Dismiss the stage tuner — the same state the footswitch and the tuner
        panel's Show button drive. */
    onClose: () => void;
  }

  let { reading, settings, reduceMotion, onClose }: Props = $props();
</script>

<!-- A stage surface, not a dialog: it deliberately blocks the rack below while
     leaving both persistent bars outside its box. The whole surface is the
     close affordance, so whichever way it was raised — footswitch or the tuner
     panel — it always dismisses with one tap anywhere. That instruction is
     printed in the status bar's tuner slot (StatusBar.svelte), which the
     readout has vacated anyway, keeping this surface to the tuner alone.
     It outranks a maximized tool panel (z-40): tuning is what the player
     raised last, and it must land on top of whatever was already on stage. -->
<button
  type="button"
  class="absolute inset-x-0 [top:calc(3.9rem_*_var(--ui-scale,1))] bottom-0 z-45 grid cursor-pointer appearance-none place-items-center overflow-hidden border-0 bg-[color-mix(in_srgb,var(--color-space)_90%,transparent)] p-0 font-[inherit] text-[inherit] backdrop-blur-[26px] backdrop-saturate-[.5]"
  aria-label="Full-size tuner — click to close"
  onclick={onClose}
>
  <TunerReadout
    active={true}
    {reading}
    display={settings.tunerDisplay}
    strobePrecision={settings.tunerStrobePrecision}
    needlePrecision={settings.tunerNeedlePrecision}
    {reduceMotion}
    variant="stage"
  />
</button>
