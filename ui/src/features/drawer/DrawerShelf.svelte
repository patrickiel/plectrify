<script lang="ts">
  import { MagnifyingGlassIcon, WarningIcon } from 'phosphor-svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import type { BlacklistedPlugin } from '../../lib/engine/types';
  import { MAX_DRAWER_HEIGHT, MIN_DRAWER_HEIGHT } from '../../lib/engine/appSettings';
  import Button from '../../lib/components/Button.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import BrowseTone3000Tile from '../tone3000/BrowseTone3000Tile.svelte';

  /**
   * The drawer's lid: the grab bar and the header row, the part that stays
   * when everything below is collapsed away.
   *
   * It holds the four controls worth reaching with the drawer shut — the route
   * to TONE3000 (which they require be reachable from anywhere their tones are
   * shown), the filter, and the rescan that decides what reopening will show.
   *
   * The whole band is the resize control, not just the grip: a 16px strip is a
   * hard thing to hit, and the shelf already reads as the drawer's movable
   * edge. So `shelfAttrs` — DrawerResize's pointer handlers — is spread on the
   * band itself, which is what its pointer capture and its stand-down-over-
   * controls test both depend on. The grip keeps the keyboard, the aria and
   * the tooltip.
   */
  interface Props {
    /** DrawerResize's pointer handlers, spread verbatim on the band — see its
        markup contract. */
    shelfAttrs: HTMLAttributes<HTMLDivElement>;
    onResizeKeydown: (e: KeyboardEvent) => void;
    /** The band's measured height: `collapsedHeight` is exactly this box, and
        it moves with the chrome type scale and with the container queries
        below, so it is read rather than assumed. */
    onMeasure: (px: number) => void;
    collapsed: boolean;
    /** Only for the separator's aria-valuenow. */
    shownHeight: number;
    filter: string;
    blacklisted: BlacklistedPlugin[];
    onManageBlacklist: () => void;
    /** The scan button's own words and its aria-label — the narrow header
        shows only the latter. */
    scanLabel: string;
    scanning: boolean;
    onScan: () => void;
    onBrowseTone3000: () => void;
    namPluginId?: string;
    onDragStart: (payload: { pluginId: string; patchId?: string; tone3000?: boolean }) => void;
    onDragEnd: () => void;
    browseRevealed: boolean;
  }

  let {
    shelfAttrs,
    onResizeKeydown,
    onMeasure,
    collapsed,
    shownHeight,
    filter = $bindable(),
    blacklisted,
    onManageBlacklist,
    scanLabel,
    scanning,
    onScan,
    onBrowseTone3000,
    namPluginId,
    onDragStart,
    onDragEnd,
    browseRevealed,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="drawer-shelf flex flex-none flex-col"
  bind:clientHeight={null, (px) => onMeasure(px ?? 0)}
  {...shelfAttrs}
>
  <!-- The grip riding the drawer's top edge — the window-splitter pattern:
       a focusable separator whose arrow keys set the drawer's height and
       whose click toggles the collapse. The pointer drag is the band's
       (above); this is where it is announced and where the keyboard reaches
       it. Svelte's a11y lint doesn't know the focusable-splitter variant of
       the separator role, hence the two ignores. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="drawer-resize-handle"
    role="separator"
    aria-orientation="horizontal"
    aria-label={collapsed
      ? 'Expand the module drawer'
      : 'Resize the module drawer — click to collapse'}
    aria-valuenow={shownHeight}
    aria-valuemin={MIN_DRAWER_HEIGHT}
    aria-valuemax={MAX_DRAWER_HEIGHT}
    tabindex="0"
    {@attach tooltip(collapsed ? 'Expand — drag or click' : 'Drag to resize · click to collapse')}
    onkeydown={onResizeKeydown}
  >
    <!-- Always-visible grip pill: the same "this edge moves" language as the
         module title bar's grab line, so resizability reads without a hover. -->
    <span class="drawer-grip-line" aria-hidden="true"></span>
  </div>
  <!-- The header sets its own control type scale and padding — the drawer's
       chrome sat a rung smaller than the rest of the app's and read as a
       hairline. Custom properties cross the component boundary; classes would
       not. -->
  <header
    class="drawer-head flex flex-none items-center gap-3 px-3 pb-2.5 [--ctl-pad-x:.6rem] [--ctl-pad-y:.34rem] [--ctl-text-sm:.76rem] [--ctl-text:.76rem]"
  >
    <BrowseTone3000Tile
      onOpen={onBrowseTone3000}
      {namPluginId}
      {onDragStart}
      {onDragEnd}
      revealed={browseRevealed}
    />
    <span class="ml-auto flex flex-none items-center gap-2.5">
      {#if blacklisted.length > 0}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 text-[.74rem] text-warn hover:underline"
          onclick={onManageBlacklist}
        >
          <WarningIcon size={13} weight="fill" aria-hidden="true" />
          {blacklisted.length}
          {blacklisted.length === 1 ? 'plugin' : 'plugins'} skipped
        </button>
      {/if}
      <div class="filter-field flex-none">
        <TextField
          bind:value={filter}
          size="sm"
          clearable
          class="w-full"
          placeholder="Filter…"
          aria-label="Filter patches and plugins"
        />
      </div>
      <!-- Narrow enough and this drops to the magnifier alone, a square
           button of exactly the same height (see .scan-btn). The label is
           what goes because the icon is the half that still reads; the
           aria-label carries the words either way, so nothing is lost with
           it. -->
      <Button
        size="sm"
        class="scan-btn gap-1.5"
        onclick={onScan}
        disabled={scanning}
        aria-label={scanLabel}
      >
        <span class="ctl-icon">
          <MagnifyingGlassIcon size={13} weight="bold" aria-hidden="true" />
        </span>
        <span class="scan-label">{scanLabel}</span>
      </Button>
    </span>
  </header>
</div>

<style>
  /* The shelf reads as the drawer's fixed lid rather than as the first row of
     the list: a slightly raised wash over the chrome, closed by a hairline and
     a soft drop shadow so the list below looks like it slides under it. It has
     to carry that on its own — it is the whole drawer when collapsed, and a
     band the same colour as the rack canvas beneath would have nothing to say
     it is a surface at all. */
  .drawer-shelf {
    position: relative;
    z-index: 1;
    /* The whole band is the drag surface, so it says so everywhere the
       pointer is not over a control of its own. */
    cursor: ns-resize;
    touch-action: none;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--color-ink) calc(7% * var(--ink-k)), transparent),
      color-mix(in srgb, var(--color-ink) calc(3.5% * var(--ink-k)), transparent)
    );
    border-bottom: 1px solid var(--edge-hair);
    /* --color-void, not a literal black: it carries its own alpha in light, so
       the same declaration lands there as a fraction of this weight instead of
       painting dark's full drop shadow across a white list. */
    box-shadow: 0 4px 10px -6px color-mix(in srgb, var(--color-void) 45%, transparent);
  }
  /* The veil idiom inverts here. An ink wash lifts a surface out of dark's
     near-black, but the same wash over near-white chrome *sinks* it — which is
     what turned the lid into a grey band sitting darker than the list it is
     meant to float above. Light lifts with --color-lit instead, and the lid is
     then the whitest thing in the drawer, closed by the hairline below it. */
  :global(:root[data-theme='light']) .drawer-shelf {
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--color-lit) 85%, transparent),
      color-mix(in srgb, var(--color-lit) 45%, transparent)
    );
    /* And no cast shadow at all. Dark needs one because a hairline between two
       near-black surfaces states an edge but not which side is on top; here the
       lid is already the whitest band on screen and the hairline below it does
       the whole job, so any dark smear under it only reads as grime. */
    box-shadow: none;
  }
  /* cursor is inherited, so the controls the resize gesture stands down over
     (SHELF_CONTROLS) must say what they are instead of showing the band's
     resize arrows. Stated outright rather than reverted: these outrank the
     utility classes that would otherwise answer, so rolling back lands on the
     user-agent default rather than on the cursor the control chose. */
  .drawer-shelf :global(:is(button, select, a, label)) {
    cursor: pointer;
  }
  .drawer-shelf :global(:is(input, textarea)) {
    cursor: text;
  }
  .drawer-shelf :global([draggable='true']) {
    cursor: grab;
  }
  .drawer-shelf :global([draggable='true']:active) {
    cursor: grabbing;
  }
  .drawer-shelf :global(button:disabled) {
    cursor: default;
  }

  /* The header degrades against its own width, not the viewport's: it is a
     container query because the drawer sits inside a chrome-scale zoom, so a
     media query would be answering about the wrong pixels. The filter gives
     way continuously (see .filter-field) and the Rescan label at one step,
     since a magnifier still reads as "look for plugins" where a bare text
     button reads as nothing. */
  .drawer-head {
    container-type: inline-size;
  }

  /* A share of the header rather than a ladder of fixed widths: the field is
     the one thing here that is useful at any size, so it takes what is left
     and keeps shrinking, floored where the placeholder gives up and capped so
     a wide drawer does not hand it half the row. */
  .filter-field {
    width: clamp(5rem, 24cqi, 14rem);
  }

  /* The extra height this field wants over the stock `sm` one, set here rather
     than as a class on the component: a clearable TextField spends its `class`
     on the wrapper that holds the button, and padding belongs to the input. */
  .filter-field :global(input) {
    padding-block: 0.3rem;
  }

  /* An icon boxed to the text's own line height: the button is then exactly
     as tall with the label as without it, and equal padding on all four
     sides makes the labelless state square with no measured height to keep
     in step with the type scale. */
  .ctl-icon {
    display: grid;
    place-items: center;
    width: 1lh;
    height: 1lh;
  }

  @container (max-width: 30rem) {
    .scan-label {
      display: none;
    }
    /* Both paddings from the one custom property — square, and it follows
       the size prop rather than restating its numbers. */
    .drawer-head :global(.scan-btn) {
      padding-inline: var(--ctl-pad-y);
    }
  }

  /* An in-flow band at the drawer's top, drawn exactly like the module title
     bar's grab strip — same grip line, same clear space around it — because
     both mean the same thing: take this edge and move it. The ::before
     extends the hit area a touch past the border above. */
  .drawer-resize-handle {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    height: 1rem;
    cursor: ns-resize;
    touch-action: none;
    outline: none;
  }
  .drawer-resize-handle::before {
    content: '';
    position: absolute;
    top: -5px;
    right: 0;
    left: 0;
    height: 6px;
  }
  .drawer-grip-line {
    width: 2rem;
    height: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-ink) 28%, transparent);
    transition: background 0.2s ease;
  }
  /* The whole shelf lights the grip, because the whole shelf is the handle —
     hovering the band and hovering the pill are the same gesture, so they
     answer the same. The tooltip stays on the pill alone: it is the one spot
     small enough that pointing at it is a question, where a tip following the
     pointer across the header would be in the way of the controls there. */
  .drawer-shelf:hover .drawer-grip-line,
  .drawer-shelf:active .drawer-grip-line,
  .drawer-resize-handle:focus-visible .drawer-grip-line {
    background: color-mix(in srgb, var(--color-accent) 70%, var(--color-ink));
  }
</style>
