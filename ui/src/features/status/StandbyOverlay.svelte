<script lang="ts">
  import { MoonIcon, WarningIcon } from 'phosphor-svelte';
  import Button from '../../lib/components/Button.svelte';
  import type { StatusState } from '../../lib/engine/types';

  interface Props {
    status: StatusState;
    onWake: () => void;
    /** Opens About & feedback, which is where reporting lives — it holds the
        environment report, and these failures are already a row in it. */
    onReport: () => void;
  }

  let { status, onWake, onReport }: Props = $props();

  // 'waking' is deliberately absent: the rebuild already raises the engine's own
  // progress dialog, and stacking a second overlay on it would just cover it.
  const asleep = $derived(status.standbyStage === 'light' || status.standbyStage === 'deep');
  const parked = $derived(status.standbyStage === 'deep');

  const idleLabel = $derived.by(() => {
    const minutes = Math.floor(status.standbyIdleSeconds / 60);
    if (minutes < 1) return 'less than a minute';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  });
</script>

{#if asleep}
  <!-- Any click or key wakes: the point of the overlay is that a user coming
       back from a break should not have to find a specific target. The button
       exists so the affordance is obvious and reachable by keyboard, not
       because it is the only way through. -->
  <div
    class="fixed inset-0 z-[65] flex cursor-pointer items-center justify-center bg-[color:color-mix(in_srgb,var(--color-void)_82%,transparent)] backdrop-blur-[3px] motion-reduce:backdrop-blur-none"
    role="button"
    tabindex="0"
    aria-label="Wake the rig from standby"
    onpointerdown={onWake}
    onkeydown={onWake}
  >
    <div class="flex max-w-[22rem] flex-col items-center gap-[.6rem] p-8 text-center text-ink/70">
      <MoonIcon size={40} weight="duotone" />
      <h2 class="text-[1.1rem] font-semibold tracking-[.02em] text-ink">
        {parked ? 'Deep standby' : 'Standby'}
      </h2>
      <p class="text-[.8rem] leading-normal">
        {#if parked}
          Plugins unloaded after {idleLabel} of silence — their RAM is free. Waking reloads the rig, which
          takes a moment.
        {:else}
          Suspended after {idleLabel} of silence. Play, click, or press a key to pick up exactly where
          you left off.
        {/if}
      </p>
      <Button class="mt-2" onclick={onWake}>Wake</Button>
    </div>
  </div>
{/if}

{#if status.standbyWakeFailures.length > 0}
  <!-- Non-modal by design: standby ran unattended, so a failure must not put a
       dialog in front of whatever the user is doing now. -->
  <div
    class="fixed right-4 bottom-14 z-[66] flex max-w-96 gap-2 rounded-[.4rem] border border-[color:color-mix(in_srgb,var(--color-warn,#d08770)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--color-void)_92%,transparent)] px-3 py-[.6rem] text-xs text-ink/85"
    role="status"
  >
    <WarningIcon size={16} weight="fill" />
    <div>
      <strong class="font-semibold">Some plugins could not be restored</strong>
      <ul class="mt-1 list-disc pl-4">
        {#each status.standbyWakeFailures as failure (failure.name)}
          <li>{failure.name}: {failure.error}</li>
        {/each}
      </ul>
      <!-- The one moment the app already knows something went wrong. Sends the
           user to About rather than straight to GitHub so the report goes with
           the diagnostics — these failures are one of its rows. -->
      <button
        type="button"
        class="mt-[.4rem] cursor-pointer rounded-control-xs text-ink/60 underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onclick={onReport}>Report this</button
      >
    </div>
  </div>
{/if}
