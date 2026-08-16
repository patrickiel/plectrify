<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { fade, slide } from 'svelte/transition';
  import { FolderOpenIcon, PencilSimpleIcon, PushPinIcon, TrashSimpleIcon } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { LooperSession, StatusState } from '../../lib/engine/types';
  import { isMac } from '../../lib/platform';
  import { formatLoopSeconds } from './looperPosition';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import CardRow from '../../lib/components/CardRow.svelte';
  import RowButton from '../../lib/components/RowButton.svelte';
  import IconButton from '../../lib/components/IconButton.svelte';
  import InlineRenameInput from '../../lib/components/InlineRenameInput.svelte';
  import SegmentedControl from '../../lib/components/SegmentedControl.svelte';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import type { AppSettings } from '../../lib/engine/types';

  interface Props {
    engine: EngineBridge;
    status: StatusState;
    appSettings: AppSettings;
    onSetAppSettings: (settings: Partial<AppSettings>) => void;
    /** Expert reveals archive maintenance; Simple keeps recall only. */
    expert?: boolean;
    /** Stage view: the panel scrolls as a whole, so the card takes its natural
        height instead of competing for a fixed one. */
    large?: boolean;
  }

  let {
    engine,
    status,
    appSettings,
    onSetAppSettings,
    expert = false,
    large = false,
  }: Props = $props();

  // Motion for what Expert reveals — see reveal.svelte.ts.
  const reveal = createReveal();

  let sessions = $state<LooperSession[]>([]);
  // Rows slide in and out as sessions are archived or deleted — but not on the
  // first delivery: subscribe replays the current list synchronously, and a
  // panel opening onto its existing archive should not unfold it. The flag
  // flips after that delivery has rendered (tick), so only real changes move.
  let listLive = $state(false);
  // onMount rather than $effect: the engine is created once.
  onMount(() =>
    engine.subscribeLooperSessions((s) => {
      sessions = s;
      if (!listLive) void tick().then(() => (listLive = true));
    }),
  );
  // A row appearing or leaving changes the list's height, so it slides — the
  // same reasoning as reveal.slide(), gated on listLive instead of mount. The
  // same parameters drive the flip that glides rows into place when a pin
  // toggle reorders them.
  const rowSlide = () => ({
    duration: listLive && !prefersReducedMotion.current ? 160 : 0,
    easing: cubicOut,
  });

  // Kept sessions stay at the top, so what the player pinned is never scrolled
  // away by new takes. The sort is stable, so each group keeps the engine's
  // newest-first order; display-only, so the engine's archive order (which
  // cleanup and the cap work off) is untouched.
  const orderedSessions = $derived([...sessions].sort((a, b) => Number(b.kept) - Number(a.kept)));

  // One load in flight; its row shows the busy state until the engine
  // confirms the loop is actually in place.
  let loadingId = $state<string | null>(null);
  let confirmingId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);

  // Loading while a take is being captured would clear it mid-performance —
  // a held loop (playing/stopped) is fine: it is archived first.
  const capturing = $derived(
    status.looperState === 'armed' ||
      status.looperState === 'recording' ||
      status.looperState === 'overdubbing',
  );

  async function load(id: string) {
    if (loadingId !== null || capturing) return;
    loadingId = id;
    try {
      await engine.loadLooperSession(id);
    } finally {
      loadingId = null;
    }
  }
</script>

<!-- `flex-1 min-h-0`: the card takes whatever the panel has left and gives it
     back as the archive grows, so a long list scrolls inside the card instead of
     pushing the MIDI learn switch off the bottom of the panel. The list's own
     `min-h-20` is the floor — below that the panel scrolls instead. -->
<Card class={['min-w-0', large ? 'shrink-0' : 'min-h-0 flex-1']}>
  <div class="flex flex-none items-center justify-between gap-2 py-[.3rem] pr-[.35rem] pl-[.6rem]">
    <span
      class="flex items-center gap-[.4rem] text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase"
    >
      Sessions
      <!-- These sit inside a row that stays put, so they fade rather than slide:
           nothing above or below them moves. -->
      {#if expert && sessions.length > 0}<span
          class="rounded-full bg-control-on px-[.35rem] font-mono text-[length:var(--ctl-text-xs)] font-medium tracking-normal text-muted tabular-nums"
          transition:fade={reveal.fade()}>{sessions.length}</span
        >{/if}
    </span>
    {#if expert}
      <span class="flex items-center" transition:fade={reveal.fade()}>
        <IconButton
          label="Open the sessions folder"
          tip="Open the sessions folder in {isMac ? 'Finder' : 'Explorer'}"
          onclick={() => engine.revealLooperSessions()}
        >
          <FolderOpenIcon size={14} aria-hidden="true" />
        </IconButton>
      </span>
    {/if}
  </div>

  <!-- The maintenance rows change the card's height, so they slide. -->
  {#if expert}
    <div transition:slide={reveal.slide()}>
      <CardRow label="Auto-cleanup">
        <SegmentedControl
          label="Session auto-cleanup"
          value={appSettings.looperSessionAutoCleanup}
          options={[
            { value: true, label: 'On', tip: 'Delete the oldest sessions past the limit' },
            { value: false, label: 'Off', tip: 'Keep every session until you delete it' },
          ]}
          onSelect={(looperSessionAutoCleanup) => onSetAppSettings({ looperSessionAutoCleanup })}
        />
      </CardRow>
      <!-- The limit only means anything while cleanup is on, so it appears with
         it rather than sitting greyed out — the same disclosure Sensitivity
         gets under Auto-arm. -->
      {#if appSettings.looperSessionAutoCleanup}
        <CardRow label="Keep">
          <input
            class="h-[1.65rem] w-[3.2rem] rounded-control-md border border-[color:var(--chrome-control-border)] bg-[var(--chrome-control-bg)] px-1 text-center font-mono text-[length:var(--ctl-text)] font-semibold text-ink shadow-[var(--chrome-control-shadow)] focus-visible:border-[color:var(--chrome-control-active-border)] focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)]"
            type="number"
            min="1"
            max="999"
            step="1"
            value={appSettings.looperSessionAutoCleanupLimit}
            aria-label="Number of sessions to keep"
            onchange={(event) =>
              onSetAppSettings({
                looperSessionAutoCleanupLimit: Number(event.currentTarget.value),
              })}
          />
        </CardRow>
      {/if}
    </div>
  {/if}

  {#if sessions.length === 0}
    <p class="m-0 px-[.6rem] py-[.5rem] font-sans text-[.68rem] font-medium text-muted">
      Clear archives the loop here.
    </p>
  {:else}
    <!-- The list is what gives way when the panel is short: it takes the space
         left over and scrolls inside the card, down to a floor of about three
         rows — below that the panel itself scrolls rather than leaving the
         archive as a sliver. -->
    <ul class="m-0 flex min-h-20 min-w-0 flex-1 list-none flex-col overflow-y-auto p-0">
      {#each orderedSessions as session (session.id)}
        <li
          class="flex h-7 shrink-0 items-center gap-[.15rem] pr-[.35rem]"
          transition:slide|global={rowSlide()}
          animate:flip={rowSlide()}
        >
          {#if expert && renamingId === session.id}
            <InlineRenameInput
              value={session.name}
              ariaLabel={`Rename ${session.name}`}
              size="sm"
              class="min-w-0 flex-1"
              onCommit={(name) => {
                engine.renameLooperSession(session.id, name);
                renamingId = null;
              }}
              onCancel={() => (renamingId = null)}
            />
          {:else if expert && confirmingId === session.id}
            <div
              class="flex h-full w-full items-center justify-end gap-1"
              role="group"
              aria-label={`Confirm deletion of ${session.name}`}
            >
              <Button
                variant="ghost"
                size="sm"
                class="h-6 [--ctl-pad-y:0]"
                aria-label={`Cancel deleting ${session.name}`}
                onclick={() => (confirmingId = null)}
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                tone="warn"
                class="h-6 [--ctl-pad-y:0]"
                aria-label={`Delete ${session.name}`}
                onclick={() => {
                  engine.deleteLooperSession(session.id);
                  confirmingId = null;
                }}
              >
                Delete
              </Button>
            </div>
          {:else}
            <RowButton
              class={[
                'h-full justify-between gap-2 rounded-none font-mono text-[.7rem] font-medium [--ctl-pad-x:.6rem] [--ctl-pad-y:.35rem]',
                loadingId === session.id ? 'text-accent' : 'text-control-body',
              ]}
              disabled={capturing || loadingId !== null}
              onclick={() => load(session.id)}
            >
              <span class="min-w-0 truncate">{session.name}</span>
              <span class="shrink-0 text-ink/50 tabular-nums">
                {loadingId === session.id ? 'loading…' : formatLoopSeconds(session.durationSeconds)}
              </span>
            </RowButton>
            {#if expert}
              <!-- The row keeps its height either way, so the maintenance
                   buttons fade in beside the name rather than sliding. -->
              <div class="flex items-center gap-[.15rem]" transition:fade={reveal.fade()}>
                <IconButton label="Rename" onclick={() => (renamingId = session.id)}>
                  <PencilSimpleIcon size={13} aria-hidden="true" />
                </IconButton>
                <!-- Kept reads off aria-pressed, so the pin's lit state and what a
                     screen reader is told cannot drift apart. -->
                <IconButton
                  tone="accent"
                  aria-pressed={session.kept}
                  label={session.kept ? 'Stop keeping this session' : 'Keep this session'}
                  tip={session.kept ? 'Include in cleanup' : 'Exclude from cleanup'}
                  onclick={() => engine.setLooperSessionKept(session.id, !session.kept)}
                >
                  <PushPinIcon
                    size={13}
                    weight={session.kept ? 'fill' : 'regular'}
                    aria-hidden="true"
                  />
                </IconButton>
                <IconButton
                  tone="warn"
                  label="Delete"
                  tip="Delete"
                  onclick={() => (confirmingId = session.id)}
                >
                  <TrashSimpleIcon size={13} aria-hidden="true" />
                </IconButton>
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Card>
