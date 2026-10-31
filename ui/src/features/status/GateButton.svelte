<script lang="ts">
  import { cn } from '../../lib/components/classNames';
  import { formatGateReduction } from '../../lib/engine/noiseGate';

  /**
   * The built-in noise gate's pill, beside the IN meter the way MUTE sits
   * beside OUT: the level it acts on is the one next to it. The click is the
   * on/off; the threshold and the rest wait behind a hover in the panel above,
   * the mute pill's arrangement exactly.
   *
   * It is also the gate's only indicator. Off is the idle pill, the same grey as
   * an unmuted MUTE. On is the accent, the colour of signal in this app, and it
   * reads as a lamp: a solid, glowing fill while the gate is open and the guitar
   * is passing, an outlined accent tint while it has closed over the hum — so a
   * player can see, without opening anything, that the silence between notes is
   * the gate's doing and not a dead cable.
   */
  interface Props {
    enabled: boolean;
    /** The engine's decision: has the gate closed over the input? */
    open: boolean;
    /** The engine's live attenuation, for the tooltip. */
    reductionDb: number;
    onToggle: () => void;
  }

  let { enabled, open, reductionDb, onToggle }: Props = $props();

  const closed = $derived(enabled && !open);
  const label = $derived(
    !enabled
      ? 'Noise gate off — click to switch it on'
      : closed
        ? `Noise gate closed, ${formatGateReduction(reductionDb)} — click to switch it off`
        : 'Noise gate on and open — click to switch it off',
  );
</script>

<button
  class={cn(
    'w-10 flex-none cursor-pointer rounded-[.2rem] border-0 py-[.2rem] text-center font-mono text-[calc(var(--footer-font-size)*.82)] leading-normal font-bold tracking-[.03em] [transition:background-color_120ms_ease,color_120ms_ease,opacity_120ms_ease]',
    !enabled &&
      'bg-[color-mix(in_srgb,var(--color-ink)_calc(12%*var(--ink-k)),transparent)] text-[color-mix(in_srgb,var(--color-ink)_55%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ink)_calc(18%*var(--ink-k)),transparent)]',
    enabled &&
      !closed &&
      'bg-accent text-accent-ink shadow-(--shadow-glow-accent-bar) hover:bg-[color:color-mix(in_srgb,var(--color-accent)_85%,var(--color-ink))]',
    closed &&
      'bg-[color:color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_45%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)]',
  )}
  aria-pressed={enabled}
  aria-label={label}
  onclick={onToggle}>GATE</button
>
