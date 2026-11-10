<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowSquareOutIcon, XIcon } from 'phosphor-svelte';
  import Button from '../../lib/components/Button.svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { HostCapabilities } from '../../lib/engine/types';
  import {
    describeUpdateInstallError,
    describeUpdateInstallPhase,
    isUpdateInstallBusy,
  } from '../../lib/engine/updateInstall';
  import { LATEST_RELEASE_URL } from '../../lib/links';
  import { shouldOfferUpdate } from './updateCheck';
  import {
    bindUpdateInstall,
    checkForUpdate,
    latestVersion,
    updateInstall,
  } from './updateStore.svelte';

  interface Props {
    engine: EngineBridge;
    /** Which host-owned facilities exist — `selfUpdate` is the one read here,
        already defaulted by App so it is never absent. */
    capabilities: HostCapabilities;
    /** The release the user already waved away, from AppSettings. */
    dismissedVersion: string;
    /** Persist the dismissal, scoped to the release being offered. */
    onDismiss: (version: string) => void;
    /** Whether the start-up check may run: the stored settings have answered
        and AppSettings.checkForUpdates is on. False until then, because the
        defaults say "on" even where the user or the installer said no. */
    checkEnabled: boolean;
  }

  let { engine, capabilities, dismissedVersion, onDismiss, checkEnabled }: Props = $props();

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

  // The one check, at start-up — once the settings say it is wanted. The app is
  // left running for hours at a time; a release landing mid-session is not
  // worth polling for, let alone interrupting a player over. checkForUpdate
  // runs at most once per launch, so switching the setting back on mid-session
  // checks then and never again.
  $effect(() => {
    if (checkEnabled) void checkForUpdate();
  });

  // The in-app install's stream, owned here because this component is always
  // mounted; the About dialog reads the same store.
  onMount(() => bindUpdateInstall(engine));

  // Closing is session-only on purpose — that is "not now". Only the explicit
  // button means "never", and only for this release.
  let closed = $state(false);
  const latest = $derived(latestVersion());
  const install = $derived(updateInstall());
  const busy = $derived(isUpdateInstallBusy(install));
  // A run in flight keeps the notice on screen whatever was clicked before it:
  // it is the only place the progress — and the moment the app is about to
  // close — is shown.
  const visible = $derived(
    busy || (!closed && shouldOfferUpdate(installed, latest, dismissedVersion)),
  );
  // Where the engine can install it, the primary action does; the browser
  // download stays as the fallback after a failure. Not on Linux even if an
  // engine ever claimed it — APT owns updates there.
  const selfUpdate = $derived(capabilities.selfUpdate && !linux);
  const failed = $derived(install.phase === 'failed');
  const percent = $derived(
    install.phase === 'downloading' && install.totalBytes > 0
      ? Math.min(100, (install.receivedBytes / install.totalBytes) * 100)
      : undefined,
  );

  function download() {
    engine.openExternalUrl(LATEST_RELEASE_URL);
    closed = true;
  }
</script>

{#if visible}
  <!-- Non-modal, for the same reason as the standby wake-failure block: nobody
       asked for this, so it must not stand between the user and their rig. -->
  <div
    class="fixed right-4 bottom-14 z-[59] flex w-[22rem] max-w-[calc(100vw-2rem)] gap-2 rounded-[.4rem] border border-accent/40 bg-[color:color-mix(in_srgb,var(--color-void)_92%,transparent)] px-3 py-[.6rem] text-xs text-ink/85"
    role="status"
  >
    <div class="min-w-0 flex-1">
      <strong class="font-semibold">
        {#if busy}
          Updating to Plectrify {install.version || latest}
        {:else}
          Plectrify {latest} is available
        {/if}
      </strong>
      {#if busy}
        <!-- The TaskDialog's bar, at notice scale: a real width while the
             download's size is known, a sweep for the stretches that have no
             measure (verifying, the UAC prompt, the hand-over to Setup). -->
        <div class="mt-[.5rem] h-1 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
          {#if percent === undefined}
            <div
              class="update-progress h-full w-1/3 rounded-full bg-accent shadow-(--shadow-glow-accent-bar)"
            ></div>
          {:else}
            <div
              class="h-full rounded-full bg-accent shadow-(--shadow-glow-accent-bar) transition-[width] duration-300"
              style:width={`${percent}%`}
            ></div>
          {/if}
        </div>
        <p class="mt-[.4rem] opacity-75">{describeUpdateInstallPhase(install)}</p>
        {#if install.phase === 'downloading' || install.phase === 'verifying'}
          <div class="mt-[.6rem] flex items-center gap-3">
            <Button size="sm" onclick={() => engine.cancelUpdateInstall()}>Cancel</Button>
          </div>
        {/if}
      {:else}
        <p class="mt-[.15rem] opacity-75">You are running {installed}.</p>
        {#if linux}
          <p class="mt-[.3rem] opacity-75">
            It installs with your system updates: open Software Updater, or run
            <code class="font-mono">sudo apt update &amp;&amp; sudo apt upgrade</code>.
          </p>
        {/if}
        {#if failed && selfUpdate}
          <p class="mt-[.3rem] text-warn/90">{describeUpdateInstallError(install.error)}</p>
        {/if}
        <div class="mt-[.6rem] flex flex-wrap items-center gap-3">
          {#if selfUpdate}
            <!-- One click: the engine downloads, verifies, installs and brings
                 the new version back. The browser download is offered beside
                 it only once this has failed. -->
            <Button size="sm" tone="accent" onclick={() => engine.installUpdate()}>
              {failed ? 'Try again' : 'Install update'}
            </Button>
            {#if failed}
              <Button size="sm" class="gap-1.5" onclick={download}>
                Download
                <ArrowSquareOutIcon size={12} />
              </Button>
            {/if}
          {:else}
            <Button size="sm" class="gap-1.5" onclick={download}>
              {linux ? "What's new" : 'Download'}
              <ArrowSquareOutIcon size={12} />
            </Button>
          {/if}
          <button
            type="button"
            class="cursor-pointer rounded-control-xs text-ink/60 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onclick={() => onDismiss(latest)}
          >
            Don't show again
          </button>
        </div>
      {/if}
    </div>
    {#if !busy}
      <button
        type="button"
        class="cursor-pointer self-start rounded-control-xs p-[.1rem] text-ink/55 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onclick={() => (closed = true)}
        aria-label="Dismiss"
      >
        <XIcon size={14} />
      </button>
    {/if}
  </div>
{/if}

<style>
  .update-progress {
    animation: update-progress 1.15s ease-in-out infinite alternate;
  }

  @keyframes update-progress {
    from {
      transform: translateX(-20%);
    }
    to {
      transform: translateX(220%);
    }
  }
</style>
