<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowSquareOutIcon, XIcon } from 'phosphor-svelte';
  import Button from '../../lib/components/Button.svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import { LATEST_RELEASE_URL } from '../../lib/links';
  import { shouldOfferUpdate } from './updateCheck';
  import { checkForUpdate, latestVersion } from './updateStore.svelte';

  interface Props {
    engine: EngineBridge;
    /** The release the user already waved away, from AppSettings. */
    dismissedVersion: string;
    /** Persist the dismissal, scoped to the release being offered. */
    onDismiss: (version: string) => void;
  }

  let { engine, dismissedVersion, onDismiss }: Props = $props();

  let installed = $state('');
  // Linux installs carry Plectrify's APT repository (scripts/aptRepository.ts),
  // so a new version is not downloaded there: it arrives with the system's own
  // updates. Sending the player to a .deb would be worse than useless — Ubuntu's
  // App Center opens it and says "Installed" with no way to upgrade.
  let linux = $state(false);
  // onMount rather than $effect: the engine outlives this component, so there
  // is nothing to react to — the returned unsubscribe is the teardown.
  onMount(() =>
    engine.subscribeAppInfo((info) => {
      installed = info.version;
      linux = info.platform === 'linux';
    }),
  );

  // The one check, at start-up. The app is left running for hours at a time; a
  // release landing mid-session is not worth polling for, let alone
  // interrupting a player over.
  onMount(() => {
    void checkForUpdate();
  });

  // Closing is session-only on purpose — that is "not now". Only the explicit
  // button means "never", and only for this release.
  let closed = $state(false);
  const latest = $derived(latestVersion());
  const visible = $derived(!closed && shouldOfferUpdate(installed, latest, dismissedVersion));

  function download() {
    engine.openExternalUrl(LATEST_RELEASE_URL);
    closed = true;
  }
</script>

{#if visible}
  <!-- Non-modal, for the same reason as the standby wake-failure block: nobody
       asked for this, so it must not stand between the user and their rig. -->
  <div
    class="fixed right-4 bottom-14 z-[59] flex max-w-[22rem] gap-2 rounded-[.4rem] border border-accent/40 bg-[color:color-mix(in_srgb,var(--color-void)_92%,transparent)] px-3 py-[.6rem] text-xs text-ink/85"
    role="status"
  >
    <div>
      <strong class="font-semibold">Plectrify {latest} is available</strong>
      <p class="mt-[.15rem] opacity-75">You are running {installed}.</p>
      {#if linux}
        <p class="mt-[.3rem] opacity-75">
          It installs with your system updates: open Software Updater, or run
          <code class="font-mono">sudo apt update &amp;&amp; sudo apt upgrade</code>.
        </p>
      {/if}
      <div class="mt-[.6rem] flex items-center gap-3">
        <Button size="sm" class="gap-1.5" onclick={download}>
          {linux ? "What's new" : 'Download'}
          <ArrowSquareOutIcon size={12} />
        </Button>
        <button
          type="button"
          class="cursor-pointer rounded-control-xs text-ink/60 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onclick={() => onDismiss(latest)}
        >
          Don't show again
        </button>
      </div>
    </div>
    <button
      type="button"
      class="cursor-pointer self-start rounded-control-xs p-[.1rem] text-ink/55 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onclick={() => (closed = true)}
      aria-label="Dismiss"
    >
      <XIcon size={14} />
    </button>
  </div>
{/if}
