<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    CaretRightIcon,
    DotsSixVerticalIcon,
    MagnifyingGlassIcon,
    WarningIcon,
  } from 'phosphor-svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { PluginScanState } from '../../lib/engine/EngineBridge';
  import type { BlacklistedPlugin, Patch, PluginInfo } from '../../lib/engine/types';
  import type { CatalogueState } from '../../lib/engine/catalogue';
  import type { CategoryNode } from '../../lib/engine/catalogue';
  import {
    groupPatches,
    groupPluginsByMaker,
    packageDrawerItems,
    type DrawerPatch,
  } from '../../lib/engine/drawerGroups';
  import { onRevealRequest, type RevealRequest } from './reveal';
  import { MAX_DRAWER_HEIGHT, MIN_DRAWER_HEIGHT } from '../../lib/engine/appSettings';
  import Button from '../../lib/components/Button.svelte';
  import TextField from '../../lib/components/TextField.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import PatchTile from './PatchTile.svelte';
  import BrowseTone3000Tile from '../tone3000/BrowseTone3000Tile.svelte';

  /**
   * The edit-mode module drawer: everything a module can be made from, laid
   * out to be dragged onto the rack's insert points. One accordion list under
   * one filter — patch categories first (a patch is a ready-made module:
   * knobs, look and tone), then bare plugins bucketed by manufacturer.
   * Clicking a tile places nothing: the insert point is the user's to choose,
   * so a tile's one gesture is the drag.
   *
   * Dumb on purpose: every list arrives as a prop and every action leaves as
   * a callback, so the in-flight drag state can live in Rack beside the
   * module-move drag it shares drop zones with.
   */
  interface Props {
    patches: Patch[];
    plugins: PluginInfo[];
    catalogue: CatalogueState;
    pluginScan: PluginScanState;
    blacklisted: BlacklistedPlugin[];
    /** Drawer height in CSS pixels (persisted app setting, pre chrome
        scale); committed back through onSetHeight when the top edge is
        dragged. */
    height: number;
    onSetHeight: (px: number) => void;
    /** Collapsed to the shelf alone — the grab bar plus the header row
        (persisted). A click on the bar toggles it; dragging the bar up
        expands, and a drag released in the bottom tenth of the workspace
        collapses. */
    collapsed: boolean;
    onSetCollapsed: (collapsed: boolean) => void;
    /** Key of the accordion section left open (persisted app setting). At
        most one section is open at a time — 'none' means all closed — and an
        empty or stale key falls back to the first section at render time
        rather than being migrated, so a rescan or a renamed category costs
        nothing. */
    openSection: string;
    onSetOpenSection: (key: string) => void;
    /** How tall the drawer may grow right now, in the same pre-scale CSS
        pixels — the workspace's measured height, so "fully expanded" means
        exactly that and no further. */
    maxHeight: number;
    /** Sunk to the shelf for the moment — Rack raises this a breath after
        a drag leaves the drawer, so the chain being aimed at is not
        half-covered by the very panel the tile came from. A breath after,
        never synchronously in dragstart: collapsing under the source in the
        same task its drag begins aborts a native drag. Visual only: unlike
        `collapsed`, nothing is persisted, and the drawer rises back the
        instant the drag ends. */
    lowered: boolean;
    /** A tile or chip drag left the drawer / ended. */
    onDragStart: (payload: { pluginId: string; patchId?: string; tone3000?: boolean }) => void;
    onDragEnd: () => void;
    onRenamePatch: (patchId: string, name: string) => void;
    onSetPatchCategory: (patchId: string, category: string) => void;
    onDeletePatch: (patchId: string) => void;
    onScan: () => void;
    onManageBlacklist: () => void;
    /** Open the TONE3000 browser with no module in mind — whatever the user
        picks becomes a patch here in the drawer. */
    onBrowseTone3000: () => void;
    /** The installed Neural Amp Modeler, so the TONE3000 tile can be dragged
        onto the rack the way a patch is. Absent disables the drag: there would
        be no plugin to build the module from. */
    namPluginId?: string;
    /** Patch ids whose TONE3000 capture is missing from disk. */
    missingCaptures?: ReadonlySet<string>;
    onRepairPatch?: (patchId: string) => void;
  }

  let {
    patches,
    plugins,
    catalogue,
    pluginScan,
    blacklisted,
    height,
    onSetHeight,
    collapsed,
    onSetCollapsed,
    openSection,
    onSetOpenSection,
    maxHeight,
    lowered,
    onDragStart,
    onDragEnd,
    onRenamePatch,
    onSetPatchCategory,
    onDeletePatch,
    onScan,
    onManageBlacklist,
    onBrowseTone3000,
    namPluginId,
    missingCaptures,
    onRepairPatch,
  }: Props = $props();

  let filter = $state('');
  const filterActive = $derived(filter.trim() !== '');

  /** Named once: it is the button's own words and its aria-label, and the
      narrow header shows only the latter. */
  const scanLabel = $derived(plugins.length === 0 ? 'Scan for plugins' : 'Rescan');

  const scanning = $derived(pluginScan.status === 'scanning');

  // --- Height resize and collapse ------------------------------------------
  // The grab bar is one control with two gestures: a drag resizes (live
  // height here, committed to the persisted setting on release, so
  // settings.json is written once per gesture rather than at pointer rate),
  // and a plain click — a release that never really moved — toggles the
  // collapse. Dragging up from collapsed expands; dragging well past the
  // minimum height collapses, so the whole range is reachable in one motion.

  /** The shelf — grab bar plus header row — is what a collapsed drawer keeps.
      A bare 16px grip was a hairline nobody could find, and the header holds
      the two controls (Browse TONE3000, the filter) that are worth reaching
      without reopening the list. Measured rather than assumed: the header's
      own height moves with the chrome type scale and with the container
      queries that drop its label text. The fallback is only what is drawn for
      the first frame before the box is measured. */
  const SHELF_FALLBACK = 54;
  let shelfHeight = $state(SHELF_FALLBACK);
  const collapsedHeight = $derived(Math.round(shelfHeight || SHELF_FALLBACK));
  /** Released in the bottom tenth of the workspace → collapse; in the top
      fifth → snap to full height. No buttons for either: the extremes of the
      one drag gesture are the maximize and minimize. */
  const COLLAPSE_FRACTION = 0.1;
  const MAXIMIZE_FRACTION = 0.8;
  /** Under this much movement a gesture is a click, not a drag. */
  const CLICK_SLOP = 4;

  let liveHeight = $state<number | null>(null);
  /** True mid-drag: the height must track the pointer 1:1, so the height
      transition (for click-collapse and keyboard steps) pauses. */
  let resizing = $state(false);

  const clampHeight = (px: number) =>
    Math.round(
      Math.max(
        MIN_DRAWER_HEIGHT,
        Math.min(MAX_DRAWER_HEIGHT, Math.min(Math.max(maxHeight, MIN_DRAWER_HEIGHT), px)),
      ),
    );
  /** Down to the shelf, whether the user parked it there or a drag out of the
      drawer is holding it out of the way. */
  const sunk = $derived(collapsed || lowered);
  /** Mid-drag the edge follows the pointer past the settings floor, all the
      way down to the shelf — pinning at the minimum while the pointer keeps
      going reads as the handle slipping — and only the release decides
      between commit, collapse and maximize. At rest the stored height is
      held to the real range. */
  const shownHeight = $derived(
    sunk ? collapsedHeight : liveHeight !== null ? liveHeight : clampHeight(height),
  );

  /** As tall as the clamp allows right now: the workspace's full height. */
  const fullHeight = $derived(clampHeight(Number.MAX_SAFE_INTEGER));

  let resizeFrom: {
    pointerY: number;
    height: number;
    scale: number;
    raw: number;
    moved: boolean;
  } | null = null;

  /** Anything on the shelf that owns the pointer itself — the TONE3000 tile
      (which is dragged), the filter field, the buttons. The shelf is the
      resize surface everywhere else. */
  const SHELF_CONTROLS = 'button, input, textarea, select, a, label, [draggable="true"]';

  function startResize(e: PointerEvent) {
    const shelf = e.currentTarget as HTMLElement;
    const target = e.target as HTMLElement | null;
    if (target?.closest(SHELF_CONTROLS)) return;
    // Pointer coordinates are window pixels; the drawer's height applies
    // inside its own chrome-scale zoom, so a pointer delta must be divided
    // back by that scale or a 150% chrome would resize half as fast. Read
    // off the drawer root — zoom does not inherit, so the shelf's own
    // computed zoom is always 1.
    const root = shelf.closest('.drawer-root') ?? shelf;
    const scale = Number(getComputedStyle(root).zoom) || 1;
    const base = collapsed ? collapsedHeight : shownHeight;
    resizeFrom = { pointerY: e.clientY, height: base, scale, raw: base, moved: false };
    shelf.setPointerCapture(e.pointerId);
  }

  function moveResize(e: PointerEvent) {
    if (!resizeFrom) return;
    const delta = (resizeFrom.pointerY - e.clientY) / resizeFrom.scale;
    if (Math.abs(delta) > CLICK_SLOP) resizeFrom.moved = true;
    if (!resizeFrom.moved) return;
    resizing = true;
    resizeFrom.raw = resizeFrom.height + delta;
    liveHeight = Math.round(Math.max(collapsedHeight, Math.min(fullHeight, resizeFrom.raw)));
    // Pulling up from the shelf is asking for the drawer back.
    if (collapsed && resizeFrom.raw > collapsedHeight + CLICK_SLOP) onSetCollapsed(false);
  }

  function endResize() {
    const gesture = resizeFrom;
    resizeFrom = null;
    resizing = false;
    if (!gesture) return;
    if (!gesture.moved) {
      // A click anywhere on the shelf: toggle between it and the stored
      // height. One surface, one pair of gestures — drag resizes, click
      // toggles — whether the pointer landed on the grip or on the band.
      onSetCollapsed(!collapsed);
    } else if (!collapsed && gesture.raw < fullHeight * COLLAPSE_FRACTION) {
      // Released in the bottom tenth: close instead of pinning to the
      // minimum, keeping the stored height for the reopen.
      onSetCollapsed(true);
    } else if (!collapsed && gesture.raw > fullHeight * MAXIMIZE_FRACTION) {
      // Released in the top fifth: snap the rest of the way to full height.
      onSetHeight(fullHeight);
    } else if (!collapsed && liveHeight !== null && clampHeight(liveHeight) !== height) {
      // The live height may sit below the settings floor (the drag follows
      // the pointer); what is stored is held to the real range.
      onSetHeight(clampHeight(liveHeight));
    }
    liveHeight = null;
  }

  /** Keyboard counterpart: arrows step the height (up from collapsed
      reopens), Enter/Space toggles the collapse like a click. */
  function resizeKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSetCollapsed(!collapsed);
      return;
    }
    const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
    if (step === 0) return;
    e.preventDefault();
    if (collapsed) {
      if (step > 0) onSetCollapsed(false);
      return;
    }
    if (step < 0 && shownHeight <= MIN_DRAWER_HEIGHT) {
      onSetCollapsed(true);
      return;
    }
    onSetHeight(clampHeight(shownHeight + step));
  }

  /** pluginName -> plugin id, for making a patch tile draggable (and dimming
      the ones whose plugin is not installed). */
  const pluginIdByName = $derived(new Map(plugins.map((p) => [p.name, p.id])));

  /** One accordion section: a patch category (heading path flattened into the
      label, "Effects · Reverb") or one manufacturer's plugins. One list for
      both because the drawer answers one question — "what can a module be
      made from" — and two parallel lists would ask it twice. */
  type DrawerSection =
    | { kind: 'patches'; key: string; label: string; entries: DrawerPatch[] }
    | { kind: 'plugins'; key: string; label: string; plugins: PluginInfo[] };

  function flattenPatchSections(nodes: CategoryNode<DrawerPatch>[], out: DrawerSection[] = []) {
    for (const node of nodes) {
      if (node.entries.length > 0)
        out.push({
          kind: 'patches',
          key: `patches:${node.path.join(' ')}`,
          label: node.path.join(' · '),
          entries: node.entries,
        });
      flattenPatchSections(node.children, out);
    }
    return out;
  }

  // One filter over both kinds: a patch matches on its own name, its plugin
  // or its heading; a plugin matches on its name or vendor (as the old picker
  // did — "neural" should find the Archetypes even though none of them carry
  // the maker's name in their own).
  const sections = $derived.by(() => {
    const q = filter.trim().toLowerCase();

    const shownPatches = q
      ? patches.filter((p) =>
          [p.name, p.displayName ?? '', p.pluginName, p.category ?? ''].some((s) =>
            s.toLowerCase().includes(q),
          ),
        )
      : patches;
    const shownPlugins = q
      ? plugins.filter(
          (p) =>
            p.name.toLowerCase().includes(q) || (p.manufacturer ?? '').toLowerCase().includes(q),
        )
      : plugins;

    const out = flattenPatchSections(groupPatches(shownPatches, catalogue.items, plugins));
    for (const [maker, makerPlugins] of groupPluginsByMaker(shownPlugins))
      out.push({ kind: 'plugins', key: `plugins:${maker}`, label: maker, plugins: makerPlugins });
    return out;
  });

  // Accordion state: at most one section open, resolved from the persisted
  // key. Clicking the open header closes it — NO_SECTION is that state's
  // stored form, unmistakable for a real key because every key carries a
  // `patches:`/`plugins:` prefix. The resolution is derived rather than
  // migrated — a key naming a section that no longer exists (plugins
  // rescanned, category renamed) silently falls back to the first section
  // without writing anything, and the stale value is overwritten on the next
  // explicit click. A filter holds every surviving section open, because a
  // match hidden behind a collapsed heading reads as no match at all; clicks
  // while filtering persist nothing, so clearing the filter returns to the
  // chosen section.
  const NO_SECTION = 'none';

  const effectiveOpenKey = $derived(
    openSection === NO_SECTION
      ? undefined
      : (sections.find((s) => s.key === openSection)?.key ?? sections[0]?.key),
  );

  function isOpen(section: DrawerSection): boolean {
    return filterActive || section.key === effectiveOpenKey;
  }

  function selectSection(section: DrawerSection) {
    if (filterActive) return;
    onSetOpenSection(section.key === effectiveOpenKey ? NO_SECTION : section.key);
  }

  const sectionSlide = $derived({
    duration: prefersReducedMotion.current ? 0 : 130,
    easing: cubicOut,
  });

  // --- Reveal ---------------------------------------------------------------
  // "Show me this in the drawer", asked by the Packages panel about a package
  // it has just installed and by a TONE3000 download about the patch it has
  // just produced (see reveal.ts). Everything between that request and the tile
  // being visible is this drawer's problem: the filter may be hiding it, its
  // section may be collapsed, the drawer itself may be collapsed, and the list
  // may be scrolled somewhere else entirely.

  /** The scrolling list, so a tile is looked up inside the drawer — Rack's
      drag ghost is a PatchTile too, and it carries the same patch id. */
  let listEl = $state<HTMLDivElement>();
  /** Ids drawn with the pulse right now; cleared once it has run its two. */
  let revealedIds = $state<ReadonlySet<string>>(new Set());
  let revealTimer: ReturnType<typeof setTimeout> | undefined;

  /** Two 0.6s pulses (see --animate-reveal-pulse), plus a breath so the last
      one finishes rather than being cut off mid-fade. */
  const REVEAL_MS = 1400;

  /** How long a request waits for the thing it names to turn up in the props.
      A reveal is asked for the moment the engine says the work is done, and
      the list it must be found in arrives on a push of its own — a downloaded
      tone's patch typically lands a beat later. Bounded, so a request naming
      something that never arrives (a content package the drawer cannot show)
      still ends as it did before: silently. */
  const RESOLVE_TIMEOUT_MS = 2000;
  const RESOLVE_POLL_MS = 60;

  /** The one thing that budget cannot cover: a package's plugin is not in this
      list until the scan that follows the install has put it there, and a scan
      is measured in seconds. So while one is running the wait does not count —
      the request is for something that is on its way, and the reveal lands on
      the list that finally has it. Bounded all the same, so a scan that never
      ends does not leave this polling for the life of the drawer. */
  const RESOLVE_SCAN_MAX_MS = 2 * 60 * 1000;

  /** The drawer tiles a request names. A package is looked up through what it
      installed; a patch is the tile itself — a downloaded tone belongs to no
      package, and its id is the one the drawer draws. */
  function revealIds(request: RevealRequest): string[] {
    if (request.kind === 'patch')
      return patches.some((p) => p.id === request.id) ? [request.id] : [];
    const { patchIds, pluginIds } = packageDrawerItems(request.id, patches, plugins);
    return [...patchIds, ...pluginIds];
  }

  async function resolveReveal(request: RevealRequest): Promise<string[]> {
    const hardStop = performance.now() + RESOLVE_SCAN_MAX_MS;
    let deadline = performance.now() + RESOLVE_TIMEOUT_MS;
    for (;;) {
      const ids = revealIds(request);
      if (ids.length > 0) return ids;
      // A scan in flight means the thing asked for may still be on its way
      // into this list, so the budget starts again from here; the hard stop is
      // what ends a wait for something that is never coming.
      if (scanning) deadline = performance.now() + RESOLVE_TIMEOUT_MS;
      if (performance.now() >= Math.min(deadline, hardStop)) return ids;
      await new Promise((resolve) => setTimeout(resolve, RESOLVE_POLL_MS));
    }
  }

  onMount(() => {
    const stop = onRevealRequest(async (request) => {
      const ids = await resolveReveal(request);
      if (ids.length === 0) return;

      // A filter would be hiding the very thing we were asked to show, and a
      // collapsed drawer shows nothing at all.
      filter = '';
      const wasCollapsed = collapsed;
      if (wasCollapsed) onSetCollapsed(false);

      // The sections list is derived from the filter just cleared. Strict
      // single-open means only one section can show the reveal: the first
      // (in list order) holding one of the ids — scrollToFirst lands the eye
      // there anyway, and the pulse marks the rest wherever they sit.
      await tick();
      const wanted = new Set(ids);
      const hit = firstSectionWith(wanted);
      if (hit && hit.key !== effectiveOpenKey) onSetOpenSection(hit.key);
      revealedIds = wanted;

      // A section that was shut mounts its tiles behind a slide, and a drawer
      // that was collapsed is still growing back to its stored height, so
      // where the tile ends up is not known until both have played out.
      await tick();
      const settle = wasCollapsed && !prefersReducedMotion.current ? 220 : 20;
      setTimeout(() => scrollToFirst(ids), sectionSlide.duration + settle);

      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => (revealedIds = new Set()), REVEAL_MS);
    });
    return () => {
      stop();
      clearTimeout(revealTimer);
    };
  });

  /** The first section holding one of these ids — the one the accordion
      opens for the reveal; a tile behind a collapsed heading is as good as
      absent. */
  function firstSectionWith(ids: ReadonlySet<string>): DrawerSection | undefined {
    return sections.find((section) =>
      section.kind === 'patches'
        ? section.entries.some((entry) => ids.has(entry.patch.id))
        : section.plugins.some((plugin) => ids.has(plugin.id)),
    );
  }

  /** The first of them in the list's own order, centred. First rather than
      each: a package can install a dozen plugins, and the pulse marks all of
      them — the scroll only has to land the eye in the right place. */
  function scrollToFirst(ids: readonly string[]) {
    const selector = ids.map((id) => `[data-reveal-id="${CSS.escape(id)}"]`).join(',');
    const el = listEl?.querySelector(selector);
    el?.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion.current ? 'instant' : 'smooth',
    });
  }

  function startPluginDrag(e: DragEvent, plugin: PluginInfo) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'copy';
    const payload = { pluginId: plugin.id };
    e.dataTransfer.setData('application/x-plectrify-new-module', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', plugin.name);
    onDragStart(payload);
  }
</script>

<div
  class={[
    'drawer-root relative flex min-h-0 flex-none [zoom:var(--ui-scale,1)] flex-col overflow-hidden rounded-t-xl border border-b-0',
    !resizing && 'drawer-animate',
  ]}
  style:height="{shownHeight}px"
  role="region"
  aria-label="Module drawer"
>
  <!-- The shelf: the grab bar and the header row, the part that stays when
       everything below is collapsed away. Measured, because `collapsedHeight`
       is exactly this box — the header's height moves with the chrome type
       scale and with its own container queries, so it is read rather than
       assumed.

       The whole band is the control, not just the grip: a 16px strip is a hard
       thing to hit, and the shelf already reads as the drawer's movable edge.
       So the pointer handlers sit here and the band carries both gestures the
       grip used to — drag resizes, click collapses — standing down only over
       the controls that own the pointer themselves (see SHELF_CONTROLS). The
       grip below keeps the keyboard, the aria and the tooltip. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="drawer-shelf flex flex-none flex-col"
    bind:clientHeight={shelfHeight}
    onpointerdown={startResize}
    onpointermove={moveResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    onlostpointercapture={endResize}
  >
    <!-- The grip riding the drawer's top edge — the window-splitter pattern:
         a focusable separator whose arrow keys set the drawer's height and
         whose click toggles the collapse. The pointer drag is the shelf's
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
      onkeydown={resizeKeydown}
    >
      <!-- Always-visible grip pill: the same "this edge moves" language as the
         module title bar's grab line, so resizability reads without a hover. -->
      <span class="drawer-grip-line" aria-hidden="true"></span>
    </div>
    <!-- One row, read left to right: what a module can be made from (the
         TONE3000 route, then the gesture that places it), and on the far
         right the two things that change what the list below holds. It rides
         on the shelf rather than above the list because these four controls
         are the ones worth reaching with the drawer shut — the route to
         TONE3000, which they require be reachable from anywhere their tones
         are shown, and the filter and rescan that decide what reopening will
         show. The header sets its own control type scale and padding — the
         drawer's chrome sat a rung smaller than the rest of the app's and
         read as a hairline. Custom properties cross the component boundary;
         classes would not. -->
    <header
      class="drawer-head flex flex-none items-center gap-3 px-3 pb-2.5 [--ctl-pad-x:.6rem] [--ctl-pad-y:.34rem] [--ctl-text-sm:.76rem] [--ctl-text:.76rem]"
    >
      <BrowseTone3000Tile onOpen={onBrowseTone3000} {namPluginId} {onDragStart} {onDragEnd} />
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
            class="w-full py-[.3rem]"
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
          disabled={pluginScan.status === 'scanning'}
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

  <!-- Kept mounted while sunk so the height can animate between the shelf and
       the stored height — and so a drag whose source tile sits in here never
       loses its source node mid-gesture. inert only for the user's own
       collapse: while `lowered` a drag from in here is live, and making the
       source's ancestor inert mid-drag aborts the drag outright. It is the
       list alone, never the shelf: the header's controls are the reason the
       shelf stays. -->
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto pb-3" bind:this={listEl} inert={collapsed}>
      {#each sections as section (section.key)}
        {@const open = isOpen(section)}
        <section class="border-t border-[var(--edge-hair)] first:border-t-0">
          <h4>
            <button
              type="button"
              class={[
                'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[length:var(--drawer-font-heading)] font-semibold tracking-[.06em] text-muted uppercase transition-colors duration-120 hover:text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
                open && 'text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
              ]}
              onclick={() => selectSection(section)}
              aria-expanded={open}
            >
              <CaretRightIcon
                size={11}
                weight="bold"
                class={[
                  'flex-none transition-[rotate] duration-130 ease-[cubic-bezier(.25,.8,.25,1)]',
                  open && 'rotate-90',
                ]}
              />
              <span class="truncate">{section.label}</span>
              {#if section.kind === 'plugins'}
                <span class="font-medium tracking-normal normal-case opacity-60">plugins</span>
              {/if}
              <span class="ml-auto pl-2 font-medium tracking-normal tabular-nums opacity-75"
                >{section.kind === 'patches'
                  ? section.entries.length
                  : section.plugins.length}</span
              >
            </button>
          </h4>
          {#if open}
            <div
              class="flex flex-wrap items-start gap-2 px-3 pt-0.5 pb-2"
              role="list"
              transition:slide={sectionSlide}
            >
              {#if section.kind === 'patches'}
                {#each section.entries as entry (entry.patch.id)}
                  <PatchTile
                    patch={entry.patch}
                    pluginId={pluginIdByName.get(entry.patch.pluginName)}
                    revealed={revealedIds.has(entry.patch.id)}
                    {onDragStart}
                    {onDragEnd}
                    onRename={(name) => onRenamePatch(entry.patch.id, name)}
                    onSetCategory={(category) => onSetPatchCategory(entry.patch.id, category)}
                    onDelete={() => onDeletePatch(entry.patch.id)}
                    captureMissing={missingCaptures?.has(entry.patch.id) ?? false}
                    onRepair={() => onRepairPatch?.(entry.patch.id)}
                  />
                {/each}
              {:else}
                {#each section.plugins as plugin (plugin.id)}
                  <span
                    class={[
                      'plugin-chip group flex cursor-grab items-center gap-1 rounded-lg border border-ink/20 bg-panel py-1 pr-2 pl-1 text-[length:var(--drawer-font-title)] text-ink/85 select-none hover:border-accent/60 hover:text-ink',
                      revealedIds.has(plugin.id) && 'animate-reveal-pulse',
                    ]}
                    data-reveal-id={plugin.id}
                    role="listitem"
                    draggable="true"
                    ondragstart={(e) => startPluginDrag(e, plugin)}
                    ondragend={onDragEnd}
                    {@attach tooltip(
                      'Drag onto a gap to add a module, or onto a module to replace it',
                    )}
                  >
                    <!-- The same grip every draggable thing in the drawer
                         carries (see BrowseTone3000Tile, PatchTile): one mark
                         that means "take hold of this". -->
                    <DotsSixVerticalIcon
                      size={14}
                      weight="bold"
                      class="flex-none text-muted opacity-60 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                    {plugin.name}
                  </span>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
      {:else}
        <p class="px-3 py-4 text-xs text-muted">
          {#if filterActive}
            No matches.
          {:else if plugins.length === 0}
            No VST3 plugins found. Scan for plugins, or install a starter set from the Packages
            panel.
          {:else}
            Nothing here yet. Save a patch from a module's patch menu, or install one from the
            Packages panel.
          {/if}
        </p>
      {/each}
    </div>
  </div>
</div>

<style>
  /* Same chrome family as the toolbar and status bar: a hairline frame over
     a blurred panel wash, rounded at the top like a sheet rising from the
     status bar, so the drawer reads as app furniture rather than as part of
     the rack canvas it borders. */
  .drawer-root {
    border-color: var(--edge-hair);
    background: var(--color-chrome);
    backdrop-filter: blur(24px);
    /* The drawer's whole type scale, four rungs, inherited by the tiles and
       badges rendered inside (PatchTile, Tone3000Badge, BrowseTone3000Tile).
       Each consumer carries a fallback for its life outside this root —
       Rack's drag ghost repeats the tile at these same sizes, while the
       module card's Tone3000Badge keeps its own smaller one. */
    --drawer-font-heading: 0.75rem; /* section headers */
    --drawer-font-title: 0.8rem; /* tile titles, plugin chips */
    --drawer-font-label: 0.7rem; /* badges, hints, secondary text */
    --drawer-font-micro: 0.6rem; /* knob labels */
  }
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
    box-shadow: 0 4px 10px -6px rgb(0 0 0 / 0.45);
  }
  /* cursor is inherited, so the controls startResize stands down over
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

  /* Click-collapse, keyboard steps and the reopen all tween; a live drag
     switches this off (see `resizing`) so the edge tracks the pointer 1:1. */
  .drawer-animate {
    transition: height 0.2s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer-animate {
      transition: none;
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
