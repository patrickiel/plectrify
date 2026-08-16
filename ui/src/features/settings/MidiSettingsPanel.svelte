<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { MidiActionId, MidiTrigger } from '../../lib/engine/types';
  import {
    assignBinding,
    clearBinding,
    clearBindings,
    describeTrigger,
    isPress,
    triggerOf,
  } from '../../lib/engine/midi';
  import Button from '../../lib/components/Button.svelte';
  import { RIG_SHORTCUT_KEYS, SCENE_SHORTCUT_KEYS } from '../rack/shortcutKeys';

  interface Props {
    engine: EngineBridge;
    midiBindings: Record<string, MidiTrigger>;
    onSetAppSettings: (settings: { midiBindings: Record<string, MidiTrigger> }) => void;
    /** True while this view's MIDI learn is armed. Bindable so App can pause
        the rack's live dispatch during a learn, and disarm it from outside —
        one armed learn app-wide, the looper's contract. */
    midiLearning?: boolean;
    /** True while a MIDI learn elsewhere (tuner, rack, looper) is armed; the
        Learn buttons here refuse to arm a second one. */
    otherLearnActive?: boolean;
  }

  let {
    engine,
    midiBindings,
    onSetAppSettings,
    midiLearning = $bindable(false),
    otherLearnActive = false,
  }: Props = $props();

  // The open-input list can change while the panel is up (hot-plug), so it is
  // subscribed rather than read once; the re-ask covers a push dropped while
  // the window was occluded (same pattern as the Info panel's refresh).
  // onMount rather than $effect: the engine is created once for the app's
  // lifetime, so there is nothing to react to.
  let devices = $state<string[]>([]);
  onMount(() => {
    engine.refreshMidiDevices();
    return engine.subscribeMidiDevices((names) => (devices = names));
  });

  // The action currently in learn mode, if any. One at a time: starting a
  // second learn moves the "Listening…" state rather than stacking it.
  // midiLearning is its bindable mirror, kept in step by setLearning below.
  let learning = $state<MidiActionId | null>(null);

  function setLearning(next: MidiActionId | null) {
    learning = next;
    midiLearning = next !== null;
  }

  // Nothing outside ever disarms an armed learn here — the other learn
  // surfaces refuse to arm beside it (their otherLearnActive) instead of
  // stealing — so the mirror only flows upward, through setLearning.
  // A panel can be navigated away from mid-learn (back row, tool switch,
  // collapse); a dead flag left true would block every other Learn app-wide.
  onDestroy(() => (midiLearning = false));

  // Learn capture: the first press while listening becomes the binding.
  // Releases are ignored (same isPress the matcher uses), so a pedal at rest
  // or a switch release can't be captured. Conflicts are last-learn-wins —
  // assignBinding steals the trigger and the stolen row visibly goes empty.
  onMount(() =>
    engine.subscribeMidiEvents((events) => {
      if (learning === null) return;
      const press = events.find(isPress);
      if (!press) return;
      onSetAppSettings({ midiBindings: assignBinding(midiBindings, learning, triggerOf(press)) });
      setLearning(null);
    }),
  );

  // One control per row, cycling clear → learn → cancel on successive clicks.
  // Clearing does not arm: unmapping a switch is a thing you do on its own, and
  // a click that both dropped the binding and started listening would capture
  // the next stray press from any pedal on the board.
  function activate(actionId: MidiActionId) {
    confirmingClear = null;
    if (learning === actionId) {
      setLearning(null);
      return;
    }
    if (midiBindings[actionId]) {
      onSetAppSettings({ midiBindings: clearBinding(midiBindings, actionId) });
      return;
    }
    if (otherLearnActive) return; // one armed learn app-wide
    setLearning(actionId);
  }

  // Escape backs out of a pending clear or an armed learn. Handled on the
  // panel root and stopped there, so the sidebar's own Escape (which restores
  // the stage view) only fires once there is nothing left to back out of.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (confirmingClear !== null) {
      confirmingClear = null;
      e.stopPropagation();
      return;
    }
    if (learning !== null) {
      setLearning(null);
      e.stopPropagation();
    }
  }

  interface ActionRow {
    id: MidiActionId;
    label: string;
  }

  interface Section {
    title: string;
    /** Singular noun for the clear-all prompt: "rig", "scene". */
    noun: string;
    prev: ActionRow;
    next: ActionRow;
    /** The indexed rows, which are also what the header tally counts. */
    rows: ActionRow[];
  }

  // Every bindable position gets a row whether or not a rig/scene exists there
  // yet — mappings target positions, and a controller is usually programmed
  // once, ahead of the library growing into it. Rigs are lettered like their
  // A–Z keyboard keys; scenes are numbered like their 1–0 keys.
  const rigRows: ActionRow[] = RIG_SHORTCUT_KEYS.map((key, i) => ({
    id: `rig:${i}`,
    label: `Rig ${key}`,
  }));
  const sceneRows: ActionRow[] = SCENE_SHORTCUT_KEYS.map((_, i) => ({
    id: `scene:${i}`,
    label: `Scene ${i + 1}`,
  }));

  const rigSection: Section = {
    title: 'Rigs',
    noun: 'rig',
    prev: { id: 'rigPrev', label: 'Previous rig' },
    next: { id: 'rigNext', label: 'Next rig' },
    rows: rigRows,
  };
  const sceneSection: Section = {
    title: 'Scenes',
    noun: 'scene',
    prev: { id: 'scenePrev', label: 'Previous scene' },
    next: { id: 'sceneNext', label: 'Next scene' },
    rows: sceneRows,
  };

  const actionIdsOf = (section: Section): MidiActionId[] =>
    [section.prev, section.next, ...section.rows].map((row) => row.id);

  /** Everything the section's Clear all would drop, verb rows included. */
  const boundInSection = (section: Section) =>
    actionIdsOf(section).filter((id) => midiBindings[id]).length;

  // The section whose Clear all is awaiting confirmation, if any. Wiping a
  // controller someone spent an evening programming is not a thing one stray
  // click should do, and the two sections confirm independently.
  // Raw, not a proxy: this holds one of the two section constants and is only
  // ever replaced, and a proxied copy would never `===` the constant it stands
  // for — which is exactly how the markup below identifies it.
  let confirmingClear = $state.raw<Section | null>(null);

  function askClear(section: Section) {
    // An armed learn would otherwise still be listening behind the prompt and
    // could bind the next press while the user is reading it.
    setLearning(null);
    confirmingClear = section;
  }

  function confirmClear(section: Section) {
    onSetAppSettings({ midiBindings: clearBindings(midiBindings, actionIdsOf(section)) });
    confirmingClear = null;
  }
</script>

{#snippet actionRow(row: ActionRow)}
  {@const bound = midiBindings[row.id]}
  {@const armed = learning === row.id}
  <div
    class="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[.35rem] py-[.1rem] pr-[.15rem] pl-2 hover:bg-[color-mix(in_srgb,var(--color-ink)_6%,transparent)]"
  >
    <span
      class={[
        'overflow-hidden text-[.8rem] text-ellipsis whitespace-nowrap',
        bound && !armed ? 'text-ink' : 'text-[color-mix(in_srgb,var(--color-ink)_70%,transparent)]',
      ]}
      title={row.label}>{row.label}</span
    >
    <button
      type="button"
      class={[
        'inline-flex h-[1.6rem] min-w-[7.5rem] cursor-pointer items-center justify-center rounded-[.35rem] border px-2 text-center font-medium transition-[color,border-color,background-color] duration-140 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        armed
          ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[.75rem] text-accent shadow-(--shadow-glow-accent-sm)'
          : bound
            ? 'border-[color-mix(in_srgb,var(--color-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] font-mono text-[.6875rem] text-accent group-hover:border-[color-mix(in_srgb,var(--color-danger)_55%,transparent)] group-hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] group-hover:text-danger'
            : 'border-transparent bg-transparent text-[.75rem] text-muted group-hover:border-[color-mix(in_srgb,var(--color-ink)_calc(18%*var(--ink-k)),transparent)] group-hover:text-ink',
      ]}
      aria-pressed={armed}
      aria-label={bound && !armed
        ? `${row.label}: ${describeTrigger(bound)} — click to clear`
        : `Learn a trigger for ${row.label}`}
      title={bound && !armed ? 'Click to clear' : undefined}
      onclick={() => activate(row.id)}
    >
      {#if armed}
        Listening…
      {:else if bound}
        {describeTrigger(bound)}
      {:else}
        Learn
      {/if}
    </button>
  </div>
{/snippet}

<!-- Rigs and scenes get the identical shape: a titled panel whose two verb rows
     sit above a hairline, with the indexed rows below it. One bordered box per
     section rather than loose rows plus a box, so the view reads as two things
     instead of four stacked fragments. -->
{#snippet sectionPanel(section: Section)}
  {@const count = section.rows.filter((row) => midiBindings[row.id]).length}
  {@const clearable = boundInSection(section)}
  <section class="flex min-h-0 flex-col" aria-label={`${section.title} bindings`}>
    <!-- The tally and Clear all share the right end of the title row, and the
         confirmation takes that same spot: the prompt lands where the click
         did, and the section it will empty stays titled beside it. -->
    <div class="flex items-center justify-between gap-3 px-[.15rem] pb-[.4rem]">
      <h3 class="text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase">
        {section.title}
      </h3>
      {#if confirmingClear === section}
        <div class="flex min-w-0 items-center gap-[.4rem]">
          <span
            class="overflow-hidden text-[.6875rem] text-ellipsis whitespace-nowrap text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]"
          >
            Clear {clearable}
            {section.noun} mapping{clearable === 1 ? '' : 's'}?
          </span>
          <Button variant="ghost" size="sm" onclick={() => (confirmingClear = null)}>Cancel</Button>
          <Button variant="ghost" size="sm" tone="danger" onclick={() => confirmClear(section)}>
            Clear
          </Button>
        </div>
      {:else}
        <div class="flex min-w-0 items-center gap-[.4rem]">
          <span
            class={[
              'font-mono text-[.6875rem] whitespace-nowrap',
              count > 0
                ? 'text-accent'
                : 'text-[color-mix(in_srgb,var(--color-muted)_60%,transparent)]',
            ]}
          >
            {count}/{section.rows.length}
          </span>
          <!-- Kept mounted but disabled with nothing to clear, so the title row
               keeps its height as the first mapping is learned. -->
          <Button
            variant="ghost"
            size="sm"
            tone="warn"
            disabled={clearable === 0}
            aria-label={`Clear all ${section.noun} mappings`}
            tip={`Clear all ${section.noun} mappings, including previous and next`}
            onclick={() => askClear(section)}
          >
            Clear all
          </Button>
        </div>
      {/if}
    </div>
    <div
      class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[.6rem] border border-[color-mix(in_srgb,var(--color-ink)_10%,transparent)] bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)]"
    >
      <div
        class="flex-none border-b border-[color-mix(in_srgb,var(--color-ink)_10%,transparent)] bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)] px-[.35rem] py-[.3rem]"
      >
        {@render actionRow(section.prev)}
        {@render actionRow(section.next)}
      </div>
      <!-- Each section scrolls its own indexed rows and takes an equal share of
           whatever height is going: stacked in one column, 26 rig rows would
           otherwise push the scene section entirely below the fold, and a fixed
           cap would leave dead space on a tall window. The share and the floor
           are the grid's job (auto-rows minmax above), so everything from the
           section down just fills its track. -->
      <div class="min-h-0 flex-1 overflow-y-auto px-[.35rem] py-[.3rem]">
        {#each section.rows as row (row.id)}
          {@render actionRow(row)}
        {/each}
      </div>
    </div>
  </section>
{/snippet}

<!-- The Escape handler lives on the root so it runs (and stops) before the
     sidebar's window-level Escape un-stages the looper's stage view. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex min-h-0 flex-1 flex-col px-3 pt-[.65rem] pb-[.9rem]" onkeydown={handleKeydown}>
  <!-- Steps first, because every "my pedal does nothing" begins with a
       controller that never showed up under Inputs — step 1 is the check.
       The footnote is separated out: it is about other panels, not this one. -->
  <ol
    class="flex list-inside list-decimal flex-col gap-[.3rem] text-xs leading-[1.5] text-muted marker:font-medium marker:text-[color-mix(in_srgb,var(--color-ink)_55%,transparent)]"
  >
    <li>
      Check that your controller is listed under <span class="text-ink">Inputs</span> below — if
      not, plug it in and click <span class="text-ink">Refresh</span>.
    </li>
    <li>
      Click the <span class="text-ink">Learn</span> button beside the rig or scene you want, then press
      the switch you want to use.
    </li>
    <li>Click a mapped button again to clear it.</li>
  </ol>
  <p
    class="mt-[.55rem] border-l-2 border-[color-mix(in_srgb,var(--color-ink)_14%,transparent)] pl-[.6rem] text-[.7rem] leading-[1.5] text-[color-mix(in_srgb,var(--color-muted)_85%,transparent)]"
  >
    Rig and scene switching works in Perform mode. Mapped elsewhere: the tuner and the output mute
    (hover them in the status bar) and the looper, metronome and song transport (on the tools
    themselves, in the tools sidebar).
  </p>
  <!-- The device strip. A recessed bar, so "what is plugged in" reads as live
       status rather than as another paragraph. -->
  <div
    class="mt-[.9rem] flex flex-wrap items-center gap-[.6rem] rounded-lg border border-[color-mix(in_srgb,var(--color-ink)_10%,transparent)] bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)] py-[.4rem] pr-[.4rem] pl-[.65rem]"
  >
    <span
      class="text-[.625rem] font-semibold tracking-[.14em] whitespace-nowrap text-muted uppercase"
      id="midi-inputs-label">Inputs</span
    >
    <div
      class="flex min-w-0 flex-1 flex-wrap items-center gap-[.35rem]"
      role="status"
      aria-labelledby="midi-inputs-label"
    >
      {#if devices.length > 0}
        {#each devices as device (device)}
          <span
            class="inline-flex items-center gap-[.35rem] rounded-full border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-[.55rem] py-[.1rem] text-[.7rem] whitespace-nowrap text-[color-mix(in_srgb,var(--color-ink)_85%,transparent)]"
          >
            <span
              class="size-1.5 rounded-full bg-accent shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]"
              aria-hidden="true"
            ></span>
            {device}
          </span>
        {/each}
      {:else}
        <span class="text-xs text-[color-mix(in_srgb,var(--color-muted)_75%,transparent)]"
          >No MIDI inputs detected</span
        >
      {/if}
    </div>
    <Button
      size="sm"
      onclick={() => engine.refreshMidiDevices()}
      tip="Re-scan the connected MIDI inputs"
    >
      Refresh
    </Button>
  </div>

  <!-- The mappings. No tuner row here: its binding is learned on the tuner
       itself (hover the tuner in the status bar), beside the readout it
       toggles. The panel body does the one scroll for the whole view, so the
       sections run at their natural length in both layouts. -->
  <!-- auto-rows minmax(13rem,1fr): stacked, the two sections split the height
       evenly (1fr of a definite track each) but never go under 13rem — the
       title row, the two verb rows and four indexed ones. Once both floors are
       hit the sidebar's own scroller takes over. -->
  <div
    class="mt-4 grid min-h-0 flex-1 auto-rows-[minmax(13rem,1fr)] grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-[1.1rem]"
  >
    {@render sectionPanel(rigSection)}
    {@render sectionPanel(sceneSection)}
  </div>
</div>
