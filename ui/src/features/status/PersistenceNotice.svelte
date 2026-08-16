<script lang="ts">
  import { WarningIcon } from 'phosphor-svelte';
  import type { StatusState } from '../../lib/engine/types';

  interface Props {
    status: StatusState;
    /** Opens About & feedback, which is where reporting lives — it holds the
        environment report a disk problem needs to be diagnosed from. */
    onReport: () => void;
  }

  let { status, onReport }: Props = $props();
</script>

{#if status.persistenceError}
  <!-- Non-modal, like the standby wake failures: this can be raised by an
       unattended autosave, so it must not put a dialog in front of a player
       mid-set. It clears itself as soon as a write to that path succeeds. -->
  <div
    class="fixed right-4 bottom-14 z-[67] flex max-w-96 gap-2 rounded-[.4rem] border border-[color:color-mix(in_srgb,var(--color-warn,#d08770)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--color-void)_92%,transparent)] px-3 py-[.6rem] text-xs text-ink/85"
    role="status"
  >
    <WarningIcon size={16} weight="fill" />
    <div>
      <strong class="font-semibold">Could not save your changes</strong>
      <p class="mt-1 [overflow-wrap:anywhere]">
        Writing {status.persistenceError} failed. Recent changes to rigs, patches or the working session
        are not on disk. Check free disk space.
      </p>
      <button
        type="button"
        class="mt-[.4rem] cursor-pointer rounded-control-xs text-ink/60 underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onclick={onReport}>Report this</button
      >
    </div>
  </div>
{/if}
