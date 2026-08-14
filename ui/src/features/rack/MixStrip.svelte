<script lang="ts">
  import {
    CaretDownIcon,
    CaretUpIcon,
    CircleNotchIcon,
    DotsThreeVerticalIcon,
    HeadphonesIcon,
    PianoKeysIcon,
    SpeakerHighIcon,
    SpeakerSlashIcon,
    TrashIcon,
  } from 'phosphor-svelte';
  import type { LaneMix } from '../../lib/engine/types';
  import { describeTrigger } from '../../lib/engine/midi';
  import InlineRenameInput from '../../lib/components/InlineRenameInput.svelte';
  import Popover from '../../lib/components/Popover.svelte';
  import { cn } from '../../lib/components/classNames';
  import { learnBadgeClass } from '../../lib/components/learnSkin';
  import { tooltip } from '../../lib/components/tooltip.svelte';

  interface Props {
    lane: LaneMix;
    /** Whether removing this lane is offered (edit mode). */
    editing: boolean;
    /** Turn the lane tag into one option of an exclusive split switch. */
    selecting?: boolean;
    selected?: boolean;
    /** The lane is passing audio right now — the switch's chosen lane, or every
        unmuted lane in mix mode. What lights the strip, since "this one is on"
        is the same fact in both modes; `selected` stays the switch's own
        semantics (which option is pressed). */
    audible?: boolean;
    /** The engine is still switching to this lane; show a spinner meanwhile. */
    pending?: boolean;
    onSelect?: () => void;
    onMix: (mix: Partial<Omit<LaneMix, 'id'>>) => void;
    /** Rename the lane; an empty name restores its positional default. */
    onRename: (name: string) => void;
    /** Reorder the lane within its split group. */
    canMoveUp: boolean;
    canMoveDown: boolean;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onRemove: () => void;
    /** True while this lane's MIDI-trigger learn is armed (rack-owned state). */
    midiLearning?: boolean;
    /** Arm (or click-again to disarm) the learn. Clear-first: the button
        clears instead when the lane is already bound. */
    onMidiLearnToggle?: () => void;
    onMidiClear?: () => void;
  }

  let {
    lane,
    editing,
    selecting = false,
    selected = false,
    audible = true,
    pending = false,
    onSelect,
    onMix,
    onRename,
    canMoveUp,
    canMoveDown,
    onMoveUp,
    onMoveDown,
    onRemove,
    midiLearning = false,
    onMidiLearnToggle,
    onMidiClear,
  }: Props = $props();

  const mixButtonClass =
    'inline-flex cursor-pointer items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--color-ink)_12%,transparent)] bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)] p-[.3rem] text-ink transition-all duration-200 hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-30 disabled:hover:border-[color-mix(in_srgb,var(--color-ink)_12%,transparent)] disabled:hover:text-ink';
  const dangerButtonClass =
    'rounded-lg border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_14%,var(--color-panel))] p-[.35rem] text-[color-mix(in_srgb,var(--color-danger)_85%,var(--color-ink))] shadow-(--shadow-panel) backdrop-blur-3xl transition-all duration-250 ease-[cubic-bezier(.25,.8,.25,1)] hover:border-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_30%,var(--color-panel))] hover:text-ink hover:shadow-[0_0_14px_color-mix(in_srgb,var(--color-danger)_35%,transparent)]';

  // No cancel-on-leaving-edit-mode needed: the rack only mounts a MixStrip in
  // edit mode, so leaving it destroys this component and any pending rename.
  let renaming = $state(false);
  // The lane's mixer, and the corner kebab that opens it.
  let menuOpen = $state(false);
  let menuBtnEl = $state<HTMLButtonElement>();

  function resetOnOpen() {
    renaming = false;
  }

  /** Right-clicking the tag opens the same mixer, which is what the old
      hover-expand had going for it: no aiming at a 20px corner chip. Routed
      through the kebab's own click rather than by assigning `menuOpen`, because
      Popover snapshots the trigger's rectangle inside its open path — set the
      flag directly and the panel is placed wherever the last one was. */
  function openMenu(e: MouseEvent) {
    if ((e.target as HTMLElement | null)?.closest('input, textarea')) return;
    e.preventDefault();
    if (!menuOpen) menuBtnEl?.click();
  }

  function commitName(value: string) {
    onRename(value);
    renaming = false;
  }

  const label = $derived(lane.name);
  // The tag grows with the name up to a cap; past a couple of characters the
  // type steps down so a word still reads at a glance next to the route line.
  const tagFontSize = $derived(
    label.length <= 2 ? '0.9375rem' : label.length <= 5 ? '0.78rem' : '0.68rem',
  );
  // The strip floats inside the anchor, so it cannot size it — the anchor takes
  // an explicit width instead. The tag is monospaced, so `ch` is exact: one
  // cell plus letter-spacing per character, plus the strip's padding + border.
  // Only a floor, no ceiling: however long the name is, it shows in full.
  const tagWidth = $derived(
    `max(2.25rem, calc(${label.length}ch + ${(label.length * 1.4).toFixed(1)}px + 0.6rem + 2px))`,
  );
  // Linear gain shown as a percentage of unity (100% = 1.0), 0…200%.
  const gainPct = $derived(Math.round(lane.gain * 100));
  const panLabel = $derived(
    lane.pan === 0 ? 'C' : `${lane.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(lane.pan) * 100)}`,
  );

  // Track fills. Level fills from the left (0 → thumb). Pan is bipolar, so its
  // fill originates at the centre and runs out to the thumb — left of centre for
  // L, right for R — matching where 0 sits on the control.
  const track = 'color-mix(in srgb, var(--color-ink) 12%, transparent)';
  const gainFill = $derived.by(() => {
    const pos = (lane.gain / 2) * 100;
    return `linear-gradient(to right, var(--color-accent) 0 ${pos}%, ${track} ${pos}% 100%)`;
  });
  const panFill = $derived.by(() => {
    const pos = ((lane.pan + 1) / 2) * 100;
    const lo = Math.min(50, pos);
    const hi = Math.max(50, pos);
    return `linear-gradient(to right, ${track} 0 ${lo}%, var(--color-accent) ${lo}% ${hi}%, ${track} ${hi}% 100%)`;
  });
</script>

<!-- Keep the route geometry compact and stable: the anchor is only ever as wide
     as the lane's name. The mixer is a menu opened from the corner kebab (or by
     right-clicking the tag), not a panel the tag grows into on hover: a strip
     that unfolds under the pointer is a large moving target over the route, it
     opens on a pointer that was only passing through, and every control inside
     it is reachable only for as long as the pointer stays within the expanded
     box. A menu stays open because it was asked for. -->
<div
  class="mix-strip-anchor"
  class:menu-visible={menuOpen || midiLearning}
  style:width={tagWidth}
  style:font-size={tagFontSize}
>
  <section
    class="mix-strip"
    class:mix-muted={lane.muted}
    class:mix-live={audible}
    aria-label="Lane {label} mixer"
    oncontextmenu={openMenu}
  >
    {#if selecting}
      <button
        type="button"
        class="lane-summary lane-select"
        onclick={onSelect}
        aria-pressed={selected}
        aria-busy={pending}
        aria-label="Select lane {label}"
        {@attach tooltip(`Switch to lane ${label}`)}
      >
        <span class="lane-tag" style:font-size={tagFontSize}>
          {#if pending}
            <CircleNotchIcon class="animate-spin text-accent" size={15} weight="bold" />
          {:else}
            {label}
          {/if}
        </span>
      </button>
    {:else}
      <div class="lane-summary">
        <div class="lane-tag" style:font-size={tagFontSize} {@attach tooltip(label)}>{label}</div>
      </div>
    {/if}

    <!-- Pinned to the tag's corner rather than placed beside it: the anchor's
         width is the route's geometry, and a button in the flow would push every
         lane's modules right by its own width. Revealed on hover like the
         module card's own kebab, and held out while its menu is open or a learn
         is listening. -->
    <Popover
      bind:open={menuOpen}
      maxHeight={360}
      gap={8}
      panelClass="w-52"
      ariaHasPopup="dialog"
      onOpen={resetOnOpen}
    >
      {#snippet trigger(props)}
        <button
          {...props}
          bind:this={menuBtnEl}
          class="lane-menu-btn"
          class:lane-menu-bound={!!lane.midi}
          class:lane-menu-armed={midiLearning}
          aria-label="Lane {label} mixer and options"
          {@attach tooltip('Lane mixer')}
        >
          <DotsThreeVerticalIcon size={18} weight="bold" aria-hidden="true" />
        </button>
      {/snippet}

      <div class="flex flex-col gap-[.6rem] p-[.6rem]">
        <!-- The lane's name heads the panel and *is* the rename field: a menu
             opened away from a narrow strip has to say which lane it belongs
             to, and a separate NAME row underneath printed the same word again
             with a label over it. Clicking the heading edits it, the way the
             module card's title does. The MIDI learn rides beside it, away from
             the mix and structural action rows. -->
        <div class="flex h-6 items-center justify-between gap-2">
          {#if editing && renaming}
            <InlineRenameInput
              value={lane.name}
              ariaLabel="Rename lane {label}"
              class="text-input min-w-0 flex-1 px-1.5 py-0.5 font-mono text-[.78rem] font-bold"
              onCommit={commitName}
              onCancel={() => (renaming = false)}
            />
          {:else if editing}
            <button
              type="button"
              class="min-w-0 cursor-text overflow-hidden rounded-sm border border-transparent bg-transparent px-[.15rem] text-left font-mono text-[.8rem] font-bold tracking-[1.4px] text-ellipsis whitespace-nowrap text-accent hover:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] focus-visible:border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] focus-visible:outline-none"
              onclick={() => (renaming = true)}
              {@attach tooltip(`Click to rename lane ${label}`)}
            >
              {label}
            </button>
          {:else}
            <span
              class="min-w-0 overflow-hidden font-mono text-[.8rem] font-bold tracking-[1.4px] text-ellipsis whitespace-nowrap text-accent"
              >{label}</span
            >
          {/if}
          {#if editing}
            <button
              class={cn(
                mixButtonClass,
                learnBadgeClass(midiLearning ? 'armed' : lane.midi ? 'bound' : 'off'),
              )}
              aria-pressed={midiLearning}
              onclick={() => (lane.midi ? onMidiClear?.() : onMidiLearnToggle?.())}
              aria-label={lane.midi
                ? `Clear lane ${label}'s MIDI trigger`
                : `Learn a MIDI trigger for lane ${label}`}
              {@attach tooltip(
                lane.midi
                  ? `${describeTrigger(lane.midi)} — click to clear`
                  : midiLearning
                    ? 'Listening — press a switch'
                    : 'Learn MIDI lane trigger',
              )}
            >
              <PianoKeysIcon size={14} weight={lane.midi ? 'fill' : 'regular'} />
            </button>
          {/if}
        </div>
        <label class="flex flex-col gap-1">
          <span
            class="flex justify-between font-mono text-[.6rem] leading-normal tracking-[1px] text-muted"
            >LVL <span class="text-ink">{gainPct}%</span></span
          >
          <input
            class="slider"
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={lane.gain}
            style="background:{gainFill}"
            ondblclick={() => onMix({ gain: 1 })}
            oninput={(e) => onMix({ gain: Number(e.currentTarget.value) })}
            aria-label="Lane {label} level"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span
            class="flex justify-between font-mono text-[.6rem] leading-normal tracking-[1px] text-muted"
            >PAN <span class="text-ink">{panLabel}</span></span
          >
          <input
            class="slider"
            type="range"
            min="-1"
            max="1"
            step="0.01"
            value={lane.pan}
            style="background:{panFill}"
            ondblclick={() => onMix({ pan: 0 })}
            oninput={(e) => onMix({ pan: Number(e.currentTarget.value) })}
            aria-label="Lane {label} pan"
          />
        </label>

        <div
          class="flex items-center justify-between gap-[.35rem]"
          role="group"
          aria-label="Lane {label} controls"
        >
          {#if editing}
            <button
              class={cn(mixButtonClass, dangerButtonClass)}
              onclick={onRemove}
              aria-label="Remove lane {label}"
              {@attach tooltip('Remove lane')}
            >
              <TrashIcon size={15} weight="bold" aria-hidden="true" />
            </button>
          {/if}

          <div class={['flex gap-[.35rem]', !editing && 'mr-auto']}>
            <button
              class={cn(
                mixButtonClass,
                lane.muted &&
                  'border-danger bg-[color-mix(in_srgb,var(--color-danger)_20%,transparent)] text-danger',
              )}
              onclick={() => onMix({ muted: !lane.muted })}
              aria-pressed={lane.muted}
              aria-label="Mute lane {label}"
              {@attach tooltip(lane.muted ? 'Unmute lane' : 'Mute lane')}
            >
              {#if lane.muted}<SpeakerSlashIcon size={14} weight="bold" />{:else}<SpeakerHighIcon
                  size={14}
                />{/if}
            </button>
            <button
              class={cn(
                mixButtonClass,
                lane.soloed &&
                  'border-accent bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-accent',
              )}
              onclick={() => onMix({ soloed: !lane.soloed })}
              aria-pressed={lane.soloed}
              aria-label="Solo lane {label}"
              {@attach tooltip(lane.soloed ? 'Unsolo lane' : 'Solo lane')}
            >
              <HeadphonesIcon size={14} weight={lane.soloed ? 'fill' : 'regular'} />
            </button>
          </div>

          {#if editing}
            <div class="flex gap-[.35rem]">
              <button
                class={mixButtonClass}
                onclick={onMoveUp}
                disabled={!canMoveUp}
                aria-label="Move lane {label} up"
                {@attach tooltip(`Move lane ${label} up`)}
              >
                <CaretUpIcon size={14} weight="bold" aria-hidden="true" />
              </button>
              <button
                class={mixButtonClass}
                onclick={onMoveDown}
                disabled={!canMoveDown}
                aria-label="Move lane {label} down"
                {@attach tooltip(`Move lane ${label} down`)}
              >
                <CaretDownIcon size={14} weight="bold" aria-hidden="true" />
              </button>
            </div>
          {/if}
        </div>
      </div>
    </Popover>
  </section>
</div>

<style>
  /* Sized to the lane name (a square for the default single letter, wider for a
     word, capped) so the route geometry stays predictable. Width and font-size
     are set inline; the mono font here is what makes the `ch` maths exact. */
  .mix-strip-anchor {
    position: relative;
    z-index: 2;
    flex: none;
    height: 2.25rem;
    font-family: var(--font-mono, monospace);
  }
  /* The kebab hangs off the tag's corner, so a hovered strip has to out-stack
     its neighbours even though nothing expands any more. */
  .mix-strip-anchor:hover,
  .mix-strip-anchor:focus-within,
  .mix-strip-anchor.menu-visible {
    z-index: 100;
  }
  .mix-strip {
    position: absolute;
    top: 50%;
    left: 0;
    width: 100%;
    height: 2.25rem;
    box-sizing: border-box;
    padding: 0;
    transform: translateY(-50%);
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--color-ink) 25%, transparent);
    background: color-mix(in srgb, var(--color-ink) 5%, transparent);
    box-shadow: 0 3px 8px color-mix(in srgb, var(--color-void) 28%, transparent);
    backdrop-filter: blur(10px);
    transition:
      background 0.22s ease,
      border-color 0.2s ease,
      box-shadow 0.22s ease;
  }
  /* Hover and an open menu light the strip the way they light any other trigger
     in the rack — the strip is one now, rather than a panel in waiting. */
  .mix-strip-anchor:hover .mix-strip,
  .mix-strip-anchor:focus-within .mix-strip,
  .mix-strip-anchor.menu-visible .mix-strip {
    border-color: color-mix(in srgb, var(--color-accent) 42%, transparent);
  }
  .mix-muted {
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  }
  /* Lit while the lane is actually passing audio. In switch mode that is the
     one chosen lane; in mix mode every unmuted lane, which is the point — the
     tag says whether this lane is being heard, and mode does not change what
     that means. A muted (or soloed-out) lane falls back to `.mix-muted`. */
  .mix-live {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-menu));
    box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 32%, transparent);
  }
  .mix-muted .lane-tag {
    opacity: 0.58;
  }
  .lane-summary {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
  }
  .lane-select {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .lane-select:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: -3px;
    border-radius: 4px;
  }
  .mix-live .lane-tag {
    color: var(--color-accent);
  }
  .lane-tag {
    /* Fixed box in every state so swapping the label for the pending spinner
       (a shorter block SVG) can't change the tag's height — the expanded strip
       is content-sized, so any tag collapse would jump the whole flyout. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 1.25rem;
    line-height: 1.25rem;
    padding: 0 0.3rem;
    font-family: var(--font-mono, monospace);
    /* Single letters match the 15px glyph on the adjacent add-module button;
       longer names step down, set inline from the name's length. */
    font-size: 0.9375rem;
    font-weight: 700;
    letter-spacing: 1.4px;
    color: var(--color-ink);
    white-space: nowrap;
    transition: color 0.2s ease;
  }
  .mix-strip-anchor:hover .lane-tag,
  .mix-strip-anchor:focus-within .lane-tag {
    color: var(--color-accent);
  }
  /* The way into the lane's mixer, and the module card's kebab at full size —
     same 18px glyph in the same 0.35rem of padding, so the two read as one
     control wherever they turn up. Square by construction rather than by a
     measurement (see `.module-more-btn`).

     Placed beside the tag rather than on its corner, because at this size a
     corner chip would cover the lane letter it is attached to. Absolute, so it
     still costs the route no width — it floats over the lane's own line for as
     long as the pointer is on it. Hidden until then: at rest a split is its
     lane letters and its route lines, and eight lanes each wearing a chip would
     read as a control surface of their own. */
  .lane-menu-btn {
    position: absolute;
    z-index: 1;
    top: 50%;
    left: calc(100% + 0.4rem);
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    border: 1px solid color-mix(in srgb, var(--color-ink) 25%, transparent);
    border-radius: var(--dock-radius, 6px);
    background: var(--color-menu);
    color: color-mix(in srgb, var(--color-ink) 75%, transparent);
    line-height: 0;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transition-property: color, border-color, background-color, opacity, visibility;
    transition-duration: 150ms, 150ms, 150ms, 200ms, 0s;
    transition-delay: 0s, 0s, 0s, 0s, 200ms;
  }
  .mix-strip-anchor:hover .lane-menu-btn,
  .mix-strip-anchor:focus-within .lane-menu-btn,
  .mix-strip-anchor.menu-visible .lane-menu-btn {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }
  .lane-menu-btn:hover,
  .lane-menu-btn:focus-visible,
  .lane-menu-btn[aria-expanded='true'] {
    border-color: var(--color-accent);
    background-color: color-mix(in srgb, var(--color-accent) 18%, var(--color-menu));
    color: var(--color-accent);
  }
  /* A bound trigger is the one piece of lane state the menu hides, so the kebab
     carries it — and an armed learn pulses, since the strip is what the player
     is looking at while reaching for the pedal. */
  .lane-menu-bound {
    color: var(--color-accent);
  }
  .lane-menu-armed {
    border-color: var(--color-accent);
    color: var(--color-accent);
    animation: lane-learn-pulse 1.2s ease-in-out infinite;
  }
  @keyframes lane-learn-pulse {
    50% {
      box-shadow: 0 0 10px color-mix(in srgb, var(--color-accent) 55%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lane-menu-armed {
      animation: none;
    }
  }
  /* Custom range so the fill can originate where the control's zero sits: from
     the left for level, from the centre for the bipolar pan (fill set inline). */
  .slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 5px;
    border-radius: 999px;
    cursor: pointer;
    outline: none;
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    /* Stays white in both themes: it rides on the accent-filled part of the
       track, so it needs to read as the brightest thing on the strip. */
    background: var(--color-lit);
    border: 1px solid color-mix(in srgb, var(--color-void) 40%, transparent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--color-accent) 45%, transparent);
  }
  .slider::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    /* Stays white in both themes: it rides on the accent-filled part of the
       track, so it needs to read as the brightest thing on the strip. */
    background: var(--color-lit);
    border: 1px solid color-mix(in srgb, var(--color-void) 40%, transparent);
  }
</style>
