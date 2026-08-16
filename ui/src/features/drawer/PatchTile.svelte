<script lang="ts">
  import { onDestroy } from 'svelte';
  import { DotsSixVerticalIcon, PencilSimpleIcon, TagIcon, TrashIcon } from 'phosphor-svelte';
  import type { Patch } from '../../lib/engine/types';
  import ModuleGlyph from '../../lib/components/icons/ModuleGlyph.svelte';
  import { ROWS, cellOf, normalizePositions } from '../../lib/engine/knobLayout';
  import { patchTitleOverride } from '../../lib/engine/patches';
  import InlineRenameInput from '../../lib/components/InlineRenameInput.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import Tone3000Badge from '../tone3000/Tone3000Badge.svelte';

  /**
   * One patch in the module drawer, drawn as a miniature of the module card
   * it will produce: the patch's accent colour, its title, and its knob
   * layout. Purely presentational — the full ModuleCard is interactive down
   * to every knob, and none of that belongs in a picker tile.
   *
   * Knob indicators sit at a fixed neutral position on purpose: a patch's
   * values live inside the plugin's opaque state blob, which the UI never
   * sees, so the tile shows the layout and makes no claim about the values.
   *
   * A TONE3000 patch shows its **tone's photograph** instead of that knob
   * grid. Every one of them is the same plugin with the same six knobs in the
   * same places, so the layout preview distinguishes nothing — while the
   * picture of the amp is the whole reason someone reaches for one of these
   * over another. Attribution stays below it either way, and a patch whose
   * artwork will not load falls back to the knob grid rather than to a hole.
   */
  interface Props {
    patch: Patch;
    /** The id to instantiate when this tile is dropped, or undefined when
        the patch's plugin is not installed — the tile then renders dimmed
        and refuses the drag, since dropping it could create nothing. */
    pluginId?: string;
    /** Pulse: the drawer was asked to show this patch (see reveal.ts). The
        drawer owns how long it lasts — the tile only draws it. */
    revealed?: boolean;
    /** A drag left this tile; Rack owns the in-flight state, because the
        payload in dataTransfer is unreadable until the drop lands. */
    onDragStart?: (payload: { pluginId: string; patchId: string }) => void;
    onDragEnd?: () => void;
    onRename?: (name: string) => void;
    /** Set ('' clears) the drawer heading this patch files under. */
    onSetCategory?: (category: string) => void;
    onDelete?: () => void;
    /** This patch's TONE3000 capture is not on disk. Reported by the engine,
        never derived — only it knows what is actually there. */
    captureMissing?: boolean;
    /** Fetch the capture again and repoint the patch at this machine's copy. */
    onRepair?: () => void;
    /** Open this tone's page on TONE3000 — the T3K mark's one action. Absent
        (a patch with no tone, or no url recorded) leaves the mark inert. */
    onOpenTone?: () => void;
    /** Show the package this patch was installed with — the **Pack** badge's
        one action. Absent (a patch the user saved, or a pack whose package is
        not in the catalogue this build fetched) leaves the badge a plain
        label, which is what it always was. */
    onShowPackage?: () => void;
    /** A Shift-drag left this tile: the drawer's own reorder gesture,
        never a rack drag — the drawer owns the in-flight state and the drop.
        Absent, the modifier changes nothing. */
    onReorderStart?: () => void;
    /** That reorder drag ended (dropped or not); the plain drag's end still
        reports through onDragEnd. */
    onReorderEnd?: () => void;
  }

  let {
    patch,
    pluginId,
    revealed = false,
    onDragStart,
    onDragEnd,
    onRename,
    onSetCategory,
    onDelete,
    captureMissing = false,
    onRepair,
    onOpenTone,
    onShowPackage,
    onReorderStart,
    onReorderEnd,
  }: Props = $props();

  /** Mirror the module card's grid at most this many columns wide; a tile is
      a preview, not the card, so a sprawling layout is clipped with a +N. */
  const MAX_COLS = 4;

  let renaming = $state(false);
  let editingCategory = $state(false);
  /** The tile's size, frozen while an inline editor is open. The tile is
      sized by its content (`w-fit`), and both editors change that content —
      the rename input carries an input's ~20-character intrinsic width, and
      the category editor replaces the whole preview — so without the freeze
      the tile jumps the moment editing starts and shoves its neighbours
      around. Measured in layout pixels (offsetWidth is blind to the chrome
      zoom), released when the editor closes so a committed rename may size
      the tile honestly. */
  let editSize = $state<{ width: number; height: number } | null>(null);

  function freezeSize() {
    editSize = tileEl ? { width: tileEl.offsetWidth, height: tileEl.offsetHeight } : null;
  }
  /** The artwork is a remote image on TONE3000's CDN, so it can simply not
      arrive — offline, or a tone taken down. One flag, and the tile goes back
      to being an ordinary patch tile. */
  let artworkFailed = $state(false);

  const artwork = $derived(artworkFailed ? undefined : patch.tone3000?.imageUrl);

  /** Draggable for either gesture: the plain drag needs an installed plugin
      (dropping it could otherwise create nothing), while a reorder is about
      the tile's place in the drawer and works for a dimmed tile too —
      startDrag sorts out which one a given drag is. */
  const draggable = $derived(
    (pluginId !== undefined || onReorderStart !== undefined) && !renaming && !editingCategory,
  );
  /** True while the current drag is the drawer's reorder rather than a rack
      drag, so dragend reports to the right owner. */
  let reorderDrag = false;

  /** Whether Shift is down right now, watched from pointerdown until the
      gesture resolves. dragstart's own `shiftKey` only answers for the moment
      that event fires, and the natural version of the gesture is just as
      often "take hold of the tile, then reach for Shift" — so the key is
      tracked live and either source of truth counts. Listeners are scoped to
      the gesture rather than the tile's life: dozens of tiles each watching
      the window forever would be noise. */
  let shiftHeld = false;

  function watchShift(e: KeyboardEvent) {
    if (e.key === 'Shift') shiftHeld = e.type === 'keydown';
  }

  function armShiftWatch(e: PointerEvent) {
    shiftHeld = e.shiftKey;
    window.addEventListener('keydown', watchShift);
    window.addEventListener('keyup', watchShift);
  }

  /** pointerup covers a click that never became a drag; a real drag swallows
      pointerup, so endDrag disarms too. Harmless to run twice. */
  function disarmShiftWatch() {
    window.removeEventListener('keydown', watchShift);
    window.removeEventListener('keyup', watchShift);
  }

  // A tile can be unmounted with a gesture in flight (its patch deleted, the
  // section filtered away); the window must not keep its listeners.
  onDestroy(disarmShiftWatch);

  /** The tile element, so the whole tile is always what follows the cursor —
      see startDrag. */
  let tileEl = $state<HTMLElement>();
  // patchTitleOverride, not a bare displayName read: a TONE3000 patch's stored
  // displayName is whatever the sealed card was called when it was saved — the
  // tone's title, as often as not — while its own name is the one the user gave
  // it. The tile must show the same title loading the patch would put on the card.
  const title = $derived(patchTitleOverride(patch) ?? patch.name);

  /** The knobs on the same sparse column-major grid the module card renders
      (see knobLayout.ts) — a patch's identity is partly *where* its knobs sit,
      so the tile keeps every cell, including the empty ones. */
  const layout = $derived.by(() => {
    const knobs = normalizePositions(patch.knobs);
    const shown = knobs.filter((k) => cellOf(k.pos ?? 0).col < MAX_COLS);
    const cols = shown.length ? Math.max(...shown.map((k) => cellOf(k.pos ?? 0).col)) + 1 : 0;
    return { shown, cols, hidden: knobs.length - shown.length };
  });

  function startDrag(e: DragEvent) {
    if (!draggable || !e.dataTransfer) return;
    // Shift held: reorder inside the drawer instead of dragging out. Shift
    // alone, on both OSes — Ctrl is the native drag-and-drop "copy" modifier
    // on Windows, where the browser claims it before the page sees the drag.
    // A distinct payload type keeps the rack's drop zones from ever seeing it.
    if ((e.shiftKey || shiftHeld) && onReorderStart) {
      reorderDrag = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-plectrify-drawer-reorder', patch.id);
      e.dataTransfer.setData('text/plain', patch.name);
      if (tileEl) {
        const rect = tileEl.getBoundingClientRect();
        e.dataTransfer.setDragImage(tileEl, e.clientX - rect.left, e.clientY - rect.top);
      }
      onReorderStart();
      return;
    }
    if (pluginId === undefined) {
      // Dimmed tile, no modifier: draggable only for the reorder's sake, so a
      // plain drag has nowhere to go and is cancelled outright.
      e.preventDefault();
      return;
    }
    reorderDrag = false;
    // copyMove, not copy, wherever the mid-drag reorder conversion is on the
    // table: Shift forces the platform drop effect to `move`, and a drag
    // whose effectAllowed excludes it has its drop refused — the reorder
    // would preview and then snap back on release.
    e.dataTransfer.effectAllowed = onReorderStart ? 'copyMove' : 'copy';
    // The custom type keeps anything that is not a rack drop zone from
    // interpreting the payload; text/plain is the Firefox-compatible minimum
    // that makes the drag real.
    const payload = { pluginId, patchId: patch.id };
    e.dataTransfer.setData('application/x-plectrify-new-module', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', patch.name);
    // A TONE3000 tile's artwork is an <img>, which the browser treats as a drag
    // source of its own — grabbing the tile by the picture would otherwise drag
    // the picture alone. Naming the tile makes the ghost the whole tile wherever
    // it was taken hold of, and the offset keeps it under the cursor rather than
    // jumping to a corner.
    if (tileEl) {
      const rect = tileEl.getBoundingClientRect();
      e.dataTransfer.setDragImage(tileEl, e.clientX - rect.left, e.clientY - rect.top);
    }
    onDragStart?.(payload);
  }

  function endDrag() {
    disarmShiftWatch();
    if (reorderDrag) onReorderEnd?.();
    else onDragEnd?.();
    reorderDrag = false;
  }

  function openRename() {
    freezeSize();
    renaming = true;
  }

  function closeRename() {
    renaming = false;
    editSize = null;
  }

  function commitRename(value: string) {
    const clean = value.trim();
    if (clean) onRename?.(clean);
    closeRename();
  }

  function openCategory() {
    freezeSize();
    editingCategory = true;
  }

  function closeCategory() {
    editingCategory = false;
    editSize = null;
  }

  function commitCategory(value: string) {
    onSetCategory?.(value.trim());
    closeCategory();
  }
</script>

<div
  class={[
    'patch-tile group relative flex w-fit max-w-56 flex-none cursor-grab flex-col overflow-hidden rounded-xl border border-ink/20 bg-panel select-none',
    patch.color && 'tile-tinted',
    patch.styleVariant === 'bold' && 'variant-bold',
    patch.styleVariant === 'outline' && 'variant-outline',
    pluginId === undefined && 'cursor-default opacity-45 grayscale-[.5]',
    revealed && 'animate-reveal-pulse',
  ]}
  style={patch.color ? `--module-color:${patch.color}` : undefined}
  style:width={editSize ? `${editSize.width}px` : undefined}
  style:height={editSize ? `${editSize.height}px` : undefined}
  data-reveal-id={patch.id}
  bind:this={tileEl}
  {draggable}
  onpointerdown={armShiftWatch}
  onpointerup={disarmShiftWatch}
  onpointercancel={disarmShiftWatch}
  ondragstart={startDrag}
  ondragend={endDrag}
  role="listitem"
  {@attach tooltip(
    pluginId === undefined
      ? `${patch.pluginName} is not installed`
      : onReorderStart
        ? 'Drag onto the rack — hold Shift to reorder inside the drawer'
        : undefined,
  )}
>
  <div class="tile-header relative flex items-center gap-1 py-1 pr-2 pl-1">
    <!-- The same grip the drawer's other draggable things carry (see
         BrowseTone3000Tile, the plugin chips): one mark meaning "take hold of
         this", dropped only when the tile cannot be dragged at all — a patch
         whose plugin is not installed is an ordinary, dimmed label. -->
    {#if pluginId !== undefined}
      <DotsSixVerticalIcon
        size={14}
        weight="bold"
        class="flex-none text-muted opacity-60 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
    {:else}
      <span class="w-1 flex-none" aria-hidden="true"></span>
    {/if}
    {#if renaming}
      <InlineRenameInput
        value={patch.name}
        ariaLabel="Rename patch"
        class="text-input min-w-0 flex-1 px-1 py-0 text-[length:var(--drawer-font-title,.8rem)]"
        onCommit={commitRename}
        onCancel={closeRename}
      />
    {:else}
      {#if patch.icon}
        <span class="tile-glyph shrink-0" aria-hidden="true">
          <ModuleGlyph icon={patch.icon} size={16} />
        </span>
      {/if}
      <span
        class="min-w-0 flex-1 truncate text-[length:var(--drawer-font-title,.8rem)] font-semibold tracking-[.2px] text-ink"
        >{title}</span
      >
      {#if patch.readOnly}
        <!-- Same floating hover reveal as the edit cluster below: the badge
             answers "why can't I edit this?", a question only asked once the
             pointer is on the tile — holding width for it all the time is
             what it costs, not what it earns. -->
        {#if onShowPackage}
          <!-- The badge is also the way back to what installed this. It
               already says "a package put me here"; the only question it
               raises is which one, and the Packages panel is the one place
               that answers. -->
          <button
            type="button"
            class="absolute inset-y-0.5 right-1 flex cursor-pointer items-center rounded bg-[color-mix(in_srgb,var(--color-panel-solid)_88%,transparent)] px-1 text-[length:var(--drawer-font-label,.7rem)] text-muted opacity-0 backdrop-blur-[2px] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-accent focus-visible:opacity-100"
            onclick={(e) => {
              // The tile is a drag source and, in the plugin list, a click
              // target of its own; neither should fire because the badge was
              // pressed.
              e.stopPropagation();
              onShowPackage?.();
            }}
            ondragstart={(e) => e.preventDefault()}
            aria-label="Show the package {patch.name} was installed with"
            {@attach tooltip('Installed with a package — show it')}>Pack</button
          >
        {:else}
          <span
            class="absolute inset-y-0.5 right-1 flex items-center rounded bg-[color-mix(in_srgb,var(--color-panel-solid)_88%,transparent)] px-1 text-[length:var(--drawer-font-label,.7rem)] text-muted opacity-0 backdrop-blur-[2px] transition-opacity group-hover:opacity-100"
            {@attach tooltip('Installed with a package')}>Pack</span
          >
        {/if}
      {:else}
        <!-- Floating over the title's right end rather than beside it, so the
             tile stays exactly as wide as its content — invisible buttons in
             the flow would hold that width open all the time. The backing
             keeps them legible over the letters they overlap. -->
        <!-- The row is the full height of the header, and each button owns its
             share of it: these are the tile's only click targets other than the
             drag, and a 13 px glyph in half a pixel of padding was a dot to aim
             at. Sized so the three still float clear of the title's last
             letters at the drawer's smallest zoom. -->
        <span
          class="absolute inset-y-0 right-1 flex items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--color-panel-solid)_88%,transparent)] px-1 opacity-0 backdrop-blur-[2px] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-muted hover:bg-ink/10 hover:text-accent"
            onclick={openRename}
            aria-label="Rename patch {patch.name}"
            {@attach tooltip('Rename patch')}
          >
            <PencilSimpleIcon size={15} />
          </button>
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-muted hover:bg-ink/10 hover:text-accent"
            onclick={openCategory}
            aria-label="Set category for patch {patch.name}"
            {@attach tooltip('Set category')}
          >
            <TagIcon size={15} />
          </button>
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-muted hover:bg-danger/15 hover:text-danger"
            onclick={onDelete}
            aria-label="Delete patch {patch.name}"
            {@attach tooltip('Delete patch')}
          >
            <TrashIcon size={15} />
          </button>
        </span>
      {/if}
    {/if}
  </div>

  <div class="flex min-h-9 flex-1 flex-col px-2 pt-1.5 pb-2">
    {#if editingCategory}
      <InlineRenameInput
        value={patch.category ?? ''}
        ariaLabel="Category for patch {patch.name} (empty for automatic)"
        class="text-input min-w-0 px-1 py-0 text-[length:var(--drawer-font-label,.7rem)]"
        onCommit={commitCategory}
        onCancel={closeCategory}
      />
    {:else if artwork}
      <!-- No crossOrigin, same reasoning as Tone3000Badge: a plain image load
           succeeds where a CORS request would fail on any CDN response that
           happens to lack the header. -->
      <img
        src={artwork}
        alt=""
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        draggable="false"
        onerror={() => (artworkFailed = true)}
        class="h-22 w-48 rounded-md object-cover"
      />
    {:else if layout.shown.length > 0}
      <div class="flex items-start gap-1">
        <div
          class="grid gap-x-1.5 gap-y-1"
          style:grid-template-columns="repeat({layout.cols}, 2.75rem)"
          style:grid-template-rows="repeat({ROWS}, auto)"
        >
          {#each layout.shown as knob (knob.pos)}
            {@const cell = cellOf(knob.pos ?? 0)}
            <span
              class="flex w-11 flex-col items-center gap-0.5"
              style:grid-column={cell.col + 1}
              style:grid-row={cell.row + 1}
            >
              <span class="mini-knob" aria-hidden="true"></span>
              <span
                class="w-full truncate text-center text-[length:var(--drawer-font-micro,.6rem)] tracking-[.02em] text-muted uppercase"
                >{knob.label}</span
              >
            </span>
          {/each}
        </div>
        {#if layout.hidden > 0}
          <span
            class="mt-1.5 rounded bg-ink/10 px-1 py-px text-[length:var(--drawer-font-label,.7rem)] text-muted"
            {@attach tooltip(`${layout.hidden} more ${layout.hidden === 1 ? 'knob' : 'knobs'}`)}
            >+{layout.hidden}</span
          >
        {/if}
      </div>
    {:else}
      <span class="truncate text-[length:var(--drawer-font-label,.7rem)] text-muted"
        >{patch.pluginName}</span
      >
    {/if}

    {#if patch.tone3000}
      <!-- Where this tone came from, and who made it. Attribution is an
           obligation under TONE3000's terms, not decoration — so it rides on
           the tile itself rather than living only in a tooltip. -->
      <div class="mt-1.5">
        <Tone3000Badge
          provenance={patch.tone3000}
          size="compact"
          missing={captureMissing}
          {onRepair}
          onOpen={onOpenTone}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  /* The header band, tint, style variants and icon follow ModuleCard's rules
     (its .module-header / .module-tinted / .variant-*) so the tile reads as a
     small version of the card it will produce — same indirection through
     --module-tint, same lightness clamps in both themes. Kept local rather
     than shared: the card's rules carry glow tokens, hover states and bypass
     variants a static tile has no use for. A patch's *texture* is deliberately
     not mirrored — at tile scale the patterns alias into noise. */
  /* The transform is for the drag ghost: Chromium snapshots a dragged element
     without isolating it from its parent, so the pixels behind the rounded
     corners — the drawer's chrome — ride into the ghost as opaque squares. A
     no-op transform forces the tile into its own paint layer and the ghost
     keeps its transparency (react-dnd#788; same rule on the drawer's plugin
     chips and BrowseTone3000Tile). */
  .patch-tile {
    transform: translate(0, 0);
  }
  .tile-header {
    background: color-mix(in srgb, var(--color-ink) 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 10%, transparent);
  }
  .tile-tinted {
    --module-tint: oklch(from var(--module-color) max(l, 0.55) c h);
    /* Re-point the accent so the knob indicators adopt the patch colour,
       exactly as they will on the module the drop creates. */
    --color-accent: var(--module-tint);
    border-color: color-mix(in srgb, var(--module-tint) 55%, transparent);
    background: color-mix(in srgb, var(--module-tint) 9%, var(--color-panel));
  }
  .tile-tinted .tile-header {
    background: color-mix(in srgb, var(--module-tint) 16%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 32%, transparent);
  }
  .tile-tinted.variant-bold {
    background: color-mix(in srgb, var(--module-tint) 26%, var(--color-panel));
    border-color: color-mix(in srgb, var(--module-tint) 85%, transparent);
  }
  .tile-tinted.variant-bold .tile-header {
    background: color-mix(in srgb, var(--module-tint) 42%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 55%, transparent);
  }
  .tile-tinted.variant-outline {
    background: var(--color-panel);
    border-color: color-mix(in srgb, var(--module-tint) 90%, transparent);
  }
  .tile-tinted.variant-outline .tile-header {
    background: color-mix(in srgb, var(--module-tint) 10%, transparent);
    border-bottom-color: color-mix(in srgb, var(--module-tint) 60%, transparent);
  }
  :global(:root[data-theme='light']) .tile-tinted {
    --module-tint: oklch(from var(--module-color) 0.52 c h);
  }
  /* Light: an uncoloured tile sits white-on-white against the drawer's
     near-white chrome, leaving its border doing all the work — so it takes a
     panel a step below the chrome instead (same value as the plugin chips'
     and BrowseTone3000Tile's light blocks). Only the unstyled ones: a tile
     the user has coloured mixes its tint over the normal white panel. */
  :global(:root[data-theme='light']) .patch-tile:not(.tile-tinted) {
    --color-panel: rgb(238 242 247 / 0.94);
    --color-panel-solid: #eef2f7;
  }
  @supports not (color: oklch(from white l c h)) {
    .tile-tinted,
    :global(:root[data-theme='light']) .tile-tinted {
      --module-tint: var(--module-color);
    }
  }

  /* Same accent-in-scope colouring as the card's header glyph. */
  .tile-glyph {
    display: inline-flex;
    color: var(--color-accent);
  }

  /* A 22px echo of the Knob face (see Knob.svelte), indicator pinned at
     12 o'clock — the neutral "no value known" position. */
  .mini-knob {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--color-knob);
    border: 1px solid color-mix(in srgb, var(--color-ink) 20%, transparent);
    box-shadow: inset 0 2px 5px color-mix(in srgb, var(--color-void) 70%, transparent);
  }
  /* Light inverts the dished face into a raised cap, same reasoning and same
     shape as the full Knob's light override — scaled to 22px. */
  :global(:root[data-theme='light']) .mini-knob {
    box-shadow:
      inset 0 1px 0 var(--color-lit),
      inset 0 -2px 4px color-mix(in srgb, var(--color-void) 30%, transparent),
      0 1px 2px color-mix(in srgb, var(--color-void) 28%, transparent);
  }
  .mini-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 50%;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: var(--color-accent);
    transform: translateX(-50%);
  }
</style>
