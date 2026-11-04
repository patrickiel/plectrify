<script lang="ts">
  import { ArrowClockwiseIcon, WarningIcon } from 'phosphor-svelte';
  import Button from '../../lib/components/Button.svelte';
  import DialogShell from '../../lib/components/DialogShell.svelte';
  import type { BlacklistedPlugin } from '../../lib/engine/types';
  import type { PluginPlatform } from '../../lib/engine/legacyPlugins';
  import { describeSkipReason } from '../../lib/engine/skippedPlugins';

  interface Props {
    entries: BlacklistedPlugin[];
    /** True while a scan runs: a retry is a scan, so it can't start another. */
    scanning: boolean;
    /** Which OS this is, for the wording of a reason (a bridge exists on
        Windows; an Intel-only build is the macOS case). */
    platform?: PluginPlatform;
    /** Clear these paths and rescan. Called with one path, or with all of the
        retryable ones for "Retry all". */
    onRetry: (paths: string[]) => void;
    onClose: () => void;
  }

  let { entries, scanning, platform, onRetry, onClose }: Props = $props();

  // Two kinds on one list: files a scan died on (a retry may bring them
  // back) and files the scan loaded far enough to learn they cannot run here
  // (a retry changes nothing — the reason is the whole message).
  const retryable = $derived(entries.filter((entry) => entry.reason === undefined));
  const unloadable = $derived(entries.filter((entry) => entry.reason !== undefined));
  const retryablePaths = $derived(retryable.map((entry) => entry.path));
</script>

<DialogShell
  labelledBy="blacklist-dialog-title"
  describedBy="blacklist-dialog-description"
  onDismiss={onClose}
  showCloseX
  cardClass="flex max-h-full max-w-lg flex-col"
  overlayClass="py-8"
>
  <div class="flex min-h-0 flex-col overflow-y-auto px-7 pt-7 pb-6">
    <h2 id="blacklist-dialog-title" class="flex items-center gap-2 text-lg font-semibold text-ink">
      <WarningIcon size={18} weight="fill" class="text-warn" aria-hidden="true" />
      Skipped plugins
    </h2>
    <!-- Two facts and no more: a scan stopped on these, and rescanning won't
         bring them back. The "or the app closed" clause stays because it is why
         a perfectly good plugin can end up here. -->
    <p id="blacklist-dialog-description" class="mt-2 text-sm leading-6 text-muted">
      {#if retryable.length > 0}
        A scan stopped while these were loading, so every scan since has skipped them. The plugin
        may have crashed, or the app may have closed mid-scan. Retry loads them again.
      {:else if unloadable.length > 0}
        These plugins were found but cannot run in Plectrify. Each line says why.
      {:else}
        Plugins a scan could not load are listed here.
      {/if}
    </p>

    <ul class="mt-5 flex flex-col gap-1.5">
      {#each retryable as entry (entry.path)}
        <li class="flex items-center gap-2 rounded-lg border border-ink/10 bg-ink/5 px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-ink/85">{entry.name}</p>
            <p class="truncate font-mono text-[11px] text-muted" title={entry.path}>{entry.path}</p>
          </div>
          <Button
            size="sm"
            class="shrink-0"
            disabled={scanning}
            onclick={() => onRetry([entry.path])}
            tip={`Retry ${entry.name}`}
          >
            Retry
          </Button>
        </li>
      {:else}
        {#if unloadable.length === 0}
          <li
            class="rounded-lg border border-ink/10 bg-ink/5 px-3 py-5 text-center text-xs text-muted"
          >
            No plugins are being skipped.
          </li>
        {/if}
      {/each}
    </ul>

    {#if retryable.length > 0}
      <div class="mt-5 flex justify-end">
        <Button
          size="sm"
          class="gap-1.5"
          disabled={scanning}
          onclick={() => onRetry(retryablePaths)}
        >
          <ArrowClockwiseIcon size={13} weight="bold" aria-hidden="true" />
          {scanning ? 'Scanning…' : `Retry all (${retryable.length})`}
        </Button>
      </div>
    {/if}

    {#if unloadable.length > 0}
      {#if retryable.length > 0}
        <h3 class="mt-6 text-sm font-semibold text-ink">Cannot run here</h3>
        <p class="mt-1 text-sm leading-6 text-muted">
          These were found and read, and cannot run in Plectrify. Retrying would not change that.
        </p>
      {/if}
      <ul class="mt-3 flex flex-col gap-1.5">
        {#each unloadable as entry (entry.path)}
          <li class="rounded-lg border border-ink/10 bg-ink/5 px-3 py-2">
            <p class="truncate text-sm text-ink/85">{entry.name}</p>
            <p class="truncate font-mono text-[11px] text-muted" title={entry.path}>{entry.path}</p>
            <p class="mt-1 text-xs leading-5 text-ink/70">
              {describeSkipReason(entry.reason ?? '', platform)}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogShell>
