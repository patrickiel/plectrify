<script lang="ts">
  import { cn } from '../../lib/components/classNames';

  /**
   * The output's master mute, as one pill beside the OUT meter. Always visible,
   * because a way to silence the rig is not something to go looking for — it is
   * the control a player reaches for with a room listening.
   *
   * It shows two different silences and never pretends they are the same. Amber
   * is a mute the player asked for; red is the feedback guard's latch, which the
   * engine sets and only a click here releases — by which time they have turned
   * something down. So a tripped click clears the latch and leaves the guard
   * armed, and the guard's own on/off lives in the panel above this button.
   */
  interface Props {
    /** The user's own mute. */
    muted: boolean;
    /** The guard's latch: is feedback holding the output muted right now? */
    feedbackMuted: boolean;
    onToggle: () => void;
    onClearFeedback: () => void;
  }

  let { muted, feedbackMuted, onToggle, onClearFeedback }: Props = $props();
</script>

<button
  class={cn(
    'w-10 flex-none cursor-pointer rounded-[.2rem] border-0 py-[.2rem] text-center font-mono text-[calc(var(--footer-font-size)*.82)] leading-normal font-bold tracking-[.03em] [transition:background-color_120ms_ease,color_120ms_ease,opacity_120ms_ease]',
    feedbackMuted
      ? 'bg-danger text-lit shadow-[0_0_7px_color-mix(in_srgb,var(--color-danger)_45%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_80%,var(--color-ink))]'
      : muted
        ? 'bg-hot text-void shadow-[0_0_7px_color-mix(in_srgb,var(--color-hot)_40%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-hot)_82%,var(--color-ink))]'
        : 'bg-[color-mix(in_srgb,var(--color-ink)_calc(12%*var(--ink-k)),transparent)] text-[color-mix(in_srgb,var(--color-ink)_55%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ink)_calc(18%*var(--ink-k)),transparent)]',
  )}
  aria-pressed={feedbackMuted ? undefined : muted}
  aria-label={feedbackMuted
    ? 'Output muted by feedback protection — click to unmute'
    : 'Mute output'}
  onclick={() => (feedbackMuted ? onClearFeedback() : onToggle())}>MUTE</button
>
