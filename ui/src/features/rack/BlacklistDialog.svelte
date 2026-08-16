<script lang="ts">
  import { ArrowClockwiseIcon, WarningIcon } from 'phosphor-svelte';
  import Button from '../../lib/components/Button.svelte';
  import DialogShell from '../../lib/components/DialogShell.svelte';
  import type { BlacklistedPlugin } from '../../lib/engine/types';

  interface Props {
    entries: BlacklistedPlugin[];
    /** True while a scan runs: a retry is a scan, so it can't start another. */
    scanning: boolean;
    /** Clear these paths and rescan. Called with one path, or with all of them
        for "Retry all". */
    onRetry: (paths: string[]) => void;
    onClose: () => void;
  }

  let { entries, scanning, onRetry, onClose }: Props = $props();

  const allPaths = $derived(entries.map((entry) => entry.path));
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
      A scan stopped while these were loading, so every scan since has skipped them. The plugin may
      have crashed, or the app may have closed mid-scan. Retry loads them again.
    </p>

    <ul class="mt-5 flex flex-col gap-1.5">
      {#each entries as entry (entry.path)}
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
        <li
          class="rounded-lg border border-ink/10 bg-ink/5 px-3 py-5 text-center text-xs text-muted"
        >
          No plugins are being skipped.
        </li>
      {/each}
    </ul>

    {#if entries.length}
      <div class="mt-5 flex justify-end">
        <Button size="sm" class="gap-1.5" disabled={scanning} onclick={() => onRetry(allPaths)}>
          <ArrowClockwiseIcon size={13} weight="bold" aria-hidden="true" />
          {scanning ? 'Scanning…' : `Retry all (${entries.length})`}
        </Button>
      </div>
    {/if}
  </div>
</DialogShell>
