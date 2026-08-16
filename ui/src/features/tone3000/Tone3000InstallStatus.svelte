<script lang="ts">
  import { onMount } from 'svelte';
  import { XIcon } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { Tone3000InstallEvent } from '../../lib/engine/tone3000';
  import Tone3000Logo from './Tone3000Logo.svelte';

  /**
   * What a tone's arrival looks like from inside Plectrify.
   *
   * Everything else about TONE3000 now happens in TONE3000's own window: the
   * user picks a tone there, that window closes itself, and the app they come
   * back to would otherwise show nothing at all for the few seconds a capture
   * takes to download and load. This is that gap, and nothing more — a small
   * card in the corner, never a dialog, because the rack stays playable
   * throughout and the tone lands on a module by itself.
   *
   * It is also the only place a failure can appear. A run the page never
   * started (the engine begins it from the OAuth callback) still has to be able
   * to say "that did not work", and "the download is fine, only the hand-off
   * failed" has a path of its own — `path` names the file on disk, which is
   * worth telling someone rather than swallowing.
   *
   * The compact T3K mark, not the wordmark: by the time this appears the user
   * has been through the splash and TONE3000's own site, so the full logo has
   * been established (see Tone3000Logo for why that ordering is a rule).
   */
  interface Props {
    engine: EngineBridge;
  }

  let { engine }: Props = $props();

  let run = $state.raw<Tone3000InstallEvent | null>(null);

  // onMount rather than $effect: the engine outlives this component, so there
  // is nothing to react to — the returned unsubscribe is the teardown.
  onMount(() =>
    engine.subscribeTone3000Install((event) => {
      // A finished run clears itself: the patch is in the drawer and on the
      // module, which is a better report than a card saying so.
      if (event.stage === 'done') {
        run = null;
        return;
      }
      run = event;
    }),
  );

  const failed = $derived(run?.stage === 'failed');
  const percent = $derived(
    run?.stage === 'downloading' && run.total
      ? Math.round((run.received! / run.total) * 100)
      : null,
  );

  const label = $derived.by(() => {
    if (!run) return '';
    if (run.stage === 'failed') return run.error ?? 'That tone did not arrive';
    if (run.stage === 'building') return 'Loading it into Neural Amp Modeler…';
    if (run.stage === 'queued') return 'Fetching that tone…';
    return percent === null ? 'Downloading…' : `Downloading… ${percent}%`;
  });
</script>

{#if run}
  <div
    class="pointer-events-auto fixed bottom-16 left-1/2 z-50 w-[min(26rem,90vw)] -translate-x-1/2 rounded-lg border border-ink/15 bg-menu/95 p-3 shadow-2xl backdrop-blur"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-start gap-3">
      <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-lit">
        <Tone3000Logo variant="mark" height={12} />
      </span>

      <div class="min-w-0 flex-1">
        <p class="truncate text-xs font-medium text-ink">
          {run?.title ?? 'TONE3000'}
        </p>
        <p class={['truncate text-[.7rem]', failed ? 'text-warn' : 'text-muted']}>{label}</p>

        {#if run?.path}
          <!-- The capture is on disk and perfectly usable; only the automatic
               hand-off failed. Saying where it went is the difference between a
               lost download and one the user can load by hand. -->
          <p class="mt-1 text-[.65rem] break-all text-muted/80">{run.path}</p>
        {/if}

        {#if percent !== null}
          <div class="mt-2 h-1 overflow-hidden rounded-full bg-ink/10">
            <div
              class="h-full rounded-full bg-accent transition-all"
              style:width="{percent}%"
            ></div>
          </div>
        {/if}
      </div>

      {#if failed}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-muted hover:text-ink"
          aria-label="Dismiss"
          onclick={() => (run = null)}
        >
          <XIcon size={13} />
        </button>
      {:else if run}
        <button
          type="button"
          class="cursor-pointer rounded px-2 py-1 text-[.7rem] text-muted hover:text-ink"
          onclick={() => {
            engine.tone3000CancelInstall();
            run = null;
          }}
        >
          Cancel
        </button>
      {/if}
    </div>
  </div>
{/if}
