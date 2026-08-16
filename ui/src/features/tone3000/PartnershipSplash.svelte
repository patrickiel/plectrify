<script lang="ts">
  import Tone3000Logo from './Tone3000Logo.svelte';

  /**
   * Shown once, before the first sign-in ever, introducing the partnership
   * before asking the user to hand TONE3000 their email.
   *
   * TONE3000 require this screen and supply the wording; the sentence below is
   * theirs with the brand filled in, and should not be rewritten for tone.
   * "Once ever" is enforced by the engine — `splashSeen` is stored natively
   * rather than in app settings, so it survives a disconnect and the page
   * cannot clear it.
   */
  interface Props {
    onContinue: () => void;
    onCancel?: () => void;
  }

  let { onContinue, onCancel }: Props = $props();
</script>

<div class="flex flex-col items-center gap-6 px-8 py-10 text-center">
  <div class="flex items-center gap-4">
    <span class="text-lg font-semibold tracking-tight text-ink">Plectrify</span>
    <span class="text-muted" aria-hidden="true">×</span>
    <Tone3000Logo height={26} />
  </div>

  <p class="max-w-md text-sm leading-relaxed text-muted">
    Plectrify has partnered with TONE3000 to give you access to a massive library of Neural Amp
    Modeler (NAM) captures and IRs of real analog gear, created by a global community of musicians.
  </p>

  <div class="flex items-center gap-2">
    {#if onCancel}
      <button
        type="button"
        class="cursor-pointer rounded-full px-4 py-2 text-sm text-muted hover:text-ink"
        onclick={onCancel}
      >
        Not now
      </button>
    {/if}
    <button
      type="button"
      class="cursor-pointer rounded-full bg-ink px-6 py-2 text-sm font-medium text-panel hover:opacity-90"
      onclick={onContinue}
    >
      Continue
    </button>
  </div>

  <p class="max-w-md text-[.7rem] leading-relaxed text-muted/70">
    You'll sign in on TONE3000. Plectrify never sees your password, and the tones you download stay
    on this computer.
  </p>
</div>
