<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    CaretRightIcon,
    DotsSixVerticalIcon,
    MagnifyingGlassIcon,
    WarningIcon,
  } from 'phosphor-svelte';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { PluginScanState } from '../../lib/engine/EngineBridge';
  import type { BlacklistedPlugin, Patch, PluginInfo } from '../../lib/engine/types';
  import type { CatalogueState } from '../../lib/engine/catalogue';
  import type { CategoryNode } from '../../lib/engine/catalogue';
  import {
    DRAWER_UNCATEGORISED,
    flattenPatchGroups,
    groupPatches,
    groupPluginsByMaker,
    orderPatchEntries,
    packageDrawerItems,
    packageIdForPatch,
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
    /** Hand order per patch section (persisted app setting): section key →
        patch ids in display order. Written back through onReorderPatches when
        a Shift-drag inside a section lands. */
    patchOrder: Record<string, string[]>;
    onReorderPatches: (sectionKey: string, patchIds: string[]) => void;
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
    /** Open a tone's page on TONE3000 — what a patch tile's T3K mark does. */
    onOpenToneUrl?: (url: string) => void;
    /** Show a package in the Packages panel — what a pack patch's **Pack**
        badge does. The drawer resolves which package; the caller owns opening
        the sidebar, since the panel is only mounted while it is the active
        tool. */
    onShowPackage?: (packageId: string) => void;
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
    patchOrder,
    onReorderPatches,
    onSetPatchCategory,
    onDeletePatch,
    onScan,
    onManageBlacklist,
    onBrowseTone3000,
    namPluginId,
    missingCaptures,
    onRepairPatch,
    onOpenToneUrl,
    onShowPackage,
  }: Props = $props();

  let filter = $state('');
  const filterActive = $derived(filter.trim() !== '');

  /** The package a pack patch's **Pack** badge points at, or undefined — for a
      patch the user saved, or for a pack whose package this build's catalogue
      does not list (an entry withdrawn since it was installed). The badge then
      stays the plain label it has always been rather than offering a jump to a
      row that is not there. */
  function packageIdOf(patch: Patch): string | undefined {
    return packageIdForPatch(patch, catalogue.items);
  }

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
  /** The in-flight reorder: which section, which tile, and the section's ids
      in the order shown right now (the live preview the drop commits).
      Declared up here because `sunk` reads it; the gesture itself lives in
      the reorder section below. */
  let reorder = $state<{ sectionKey: string; patchId: string; ids: string[] } | null>(null);

  /** Down to the shelf, whether the user parked it there or a drag out of the
      drawer is holding it out of the way. A live reorder overrides the
      lowering: a rack drag converted mid-flight (see convertOnShift) needs the
      list it is reordering back on screen, and Rack keeps `lowered` up until
      the drag ends. */
  const sunk = $derived((collapsed || lowered) && reorder === null);
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
      label, "Effects · Reverb") or the single Plugins section, whose maker
      buckets render as fixed sub-headings inside it rather than as sections of
      their own — a dozen collapsed vendor rows told nothing about what was
      installed, where one open list under one heading shows all of it. One
      list for both kinds because the drawer answers one question — "what can
      a module be made from" — and two parallel lists would ask it twice. */
  type DrawerSection =
    | { kind: 'patches'; key: string; label: string; entries: DrawerPatch[] }
    | { kind: 'plugins'; key: string; label: string; groups: [string, PluginInfo[]][] };

  function flattenPatchSections(nodes: CategoryNode<DrawerPatch>[]): DrawerSection[] {
    return flattenPatchGroups(nodes).map((group) => ({
      kind: 'patches',
      key: group.key,
      label: group.label,
      entries: group.entries,
    }));
  }

  // One filter over both kinds: a patch matches on its own name, its plugin
  // or its heading; a plugin matches on its name or vendor (as the old picker
  // did — "neural" should find the Archetypes even though none of them carry
  // the maker's name in their own).
  const grouped = $derived.by(() => {
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
    const makers = groupPluginsByMaker(shownPlugins);
    if (makers.length > 0)
      out.push({ kind: 'plugins', key: 'plugins', label: 'Plugins', groups: makers });
    return out;
  });

  /** The Uncategorised patches are the special case: no heading and no
      accordion — their tiles sit resolved at the very top of the list, above
      the sections, so a freshly saved patch is in sight rather than filed
      under a label that only says it was not filed. Still a section object
      underneath, so the reorder and refile gestures work on it unchanged. */
  const UNCATEGORISED_KEY = `patches:${DRAWER_UNCATEGORISED}`;
  type PatchSection = Extract<DrawerSection, { kind: 'patches' }>;
  const uncategorised = $derived(
    grouped.find((s): s is PatchSection => s.key === UNCATEGORISED_KEY),
  );
  const sections = $derived(grouped.filter((s) => s.key !== UNCATEGORISED_KEY));

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

  /** FLIP for the tiles while a reorder drag shuffles them: the preview
      reads as tiles stepping aside rather than the list snapping between
      states. Also carries the settling after a drop, a rename's re-sort and
      a re-filed patch arriving in its new section, since all of them are the
      same keyed list changing order. */
  const tileFlip = $derived({
    duration: prefersReducedMotion.current ? 0 : 180,
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
  /** The same, for the shelf's TONE3000 tile, which has no id to be in that
      set: it is one tile in a fixed place rather than one of a list. */
  let browseRevealed = $state(false);
  let browseTimer: ReturnType<typeof setTimeout> | undefined;

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
  function revealIds(request: Exclude<RevealRequest, { kind: 'browse' }>): string[] {
    if (request.kind === 'patch')
      return patches.some((p) => p.id === request.id) ? [request.id] : [];
    const { patchIds, pluginIds } = packageDrawerItems(request.id, patches, plugins);
    return [...patchIds, ...pluginIds];
  }

  async function resolveReveal(
    request: Exclude<RevealRequest, { kind: 'browse' }>,
  ): Promise<string[]> {
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
      // The TONE3000 tile is in the shelf, not in the list: nothing to resolve,
      // nothing to scroll to, and no section to open — raising the drawer is
      // the whole of it. (The tile survives a collapse, but a request to look
      // at the drawer that left it shut would be answering a different
      // question.)
      if (request.kind === 'browse') {
        if (collapsed) onSetCollapsed(false);
        browseRevealed = true;
        clearTimeout(browseTimer);
        browseTimer = setTimeout(() => (browseRevealed = false), REVEAL_MS);
        return;
      }

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
      if (hit && hit.key !== effectiveOpenKey && hit.key !== UNCATEGORISED_KEY)
        onSetOpenSection(hit.key);
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
      clearTimeout(browseTimer);
      // The drawer can be unmounted with an armed drag in flight (leaving
      // edit mode); the window must not keep the conversion listener.
      window.removeEventListener('dragover', convertOnShift);
    };
  });

  /** The first section holding one of these ids — the one the accordion
      opens for the reveal; a tile behind a collapsed heading is as good as
      absent. Searches the uncategorised row too: its tiles are always
      visible, so a hit there needs no section opened at all. */
  function firstSectionWith(ids: ReadonlySet<string>): DrawerSection | undefined {
    return grouped.find((section) =>
      section.kind === 'patches'
        ? section.entries.some((entry) => ids.has(entry.patch.id))
        : section.groups.some(([, makerPlugins]) =>
            makerPlugins.some((plugin) => ids.has(plugin.id)),
          ),
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

  // --- Reorder inside the drawer -------------------------------------------
  // A tile dragged with Shift held stays the drawer's business: the
  // list live-reorders under the pointer, the drop commits the order to the
  // persisted setting, and a drag released anywhere else snaps back. Scoped
  // to the section the tile came from — a tile's place in another category is
  // a category change, which is the tag button's job, not this gesture's.

  /** A plain rack drag in flight from one of our patch tiles. Shift pressed
      *mid-drag* cannot be seen by anyone's keydown — Chromium delivers no
      keyboard events while a native drag runs — but every dragover carries
      the live modifier state, so an armed drag crossing the drawer with Shift
      down is converted into a reorder (see convertOnShift). Armed only, never
      committed: without the Shift it stays the rack's drag untouched. */
  let armed = $state<{ sectionKey: string; patchId: string } | null>(null);

  /** A section's entries as displayed: the persisted hand order over the
      name-sorted list, overridden by the live preview while a reorder drag is
      over this section. */
  function orderedEntries(section: Extract<DrawerSection, { kind: 'patches' }>): DrawerPatch[] {
    const base = orderPatchEntries(section.entries, patchOrder[section.key]);
    if (reorder?.sectionKey !== section.key) return base;
    const byId = new Map(base.map((entry) => [entry.patch.id, entry]));
    return reorder.ids.flatMap((id) => byId.get(id) ?? []);
  }

  function startReorder(sectionKey: string, patchId: string) {
    const section = grouped.find(
      (s): s is Extract<DrawerSection, { kind: 'patches' }> =>
        s.kind === 'patches' && s.key === sectionKey,
    );
    if (!section) return;
    reorder = {
      sectionKey,
      patchId,
      ids: orderPatchEntries(section.entries, patchOrder[sectionKey]).map((e) => e.patch.id),
    };
  }

  /** The mid-drag conversion: while an armed rack drag holds Shift it is a
      reorder and the drawer rises to meet it; releasing Shift hands the drag
      back to the rack — the preview snaps back and the drawer lowers out of
      the way again. Watched on the window, not the drawer: dragover bubbles
      up from wherever the cursor is, so both directions answer the key
      itself rather than waiting for the drag to find the drawer's lowered
      shelf. Dropping on the rack still inserts regardless. */
  function convertOnShift(e: DragEvent) {
    if (!armed) return;
    if (e.shiftKey && !reorder) startReorder(armed.sectionKey, armed.patchId);
    else if (!e.shiftKey && reorder) reorder = null;
  }

  // --- Re-filing: dropping the reorder on another category ------------------
  // A reorder drag released over a *different* patch section — its header, or
  // its open list — re-files the patch under that heading instead of moving
  // it within its own. The category written is the section's label, which
  // patchCategory reads back as a path (see CATEGORY_PATH_SEPARATOR), so a
  // nested section is an exact target, not an approximation of one.

  /** The section a reorder drag would re-file into if released right now —
      drawn highlighted so the header answers before the drop commits. */
  let refileKey = $state<string | null>(null);

  /** Whether this section can take the dragged patch: another patch section,
      and a patch of the user's own — a pack's read-only patch is filed by its
      pack and cannot be re-filed, exactly as its tile offers no tag button. */
  function canRefile(section: DrawerSection): boolean {
    if (!reorder || section.kind !== 'patches' || section.key === reorder.sectionKey) return false;
    const dragged = patches.find((p) => p.id === reorder!.patchId);
    return dragged !== undefined && !dragged.readOnly;
  }

  function refileOver(e: DragEvent, section: DrawerSection) {
    if (!canRefile(section)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    refileKey = section.key;
  }

  function refileLeave(section: DrawerSection) {
    if (refileKey === section.key) refileKey = null;
  }

  function refileDrop(e: DragEvent, section: DrawerSection) {
    if (!canRefile(section) || section.kind !== 'patches') return;
    e.preventDefault();
    onSetPatchCategory(reorder!.patchId, section.label);
    refileKey = null;
    reorder = null;
  }

  /** Live preview: as the drag crosses a tile, the dragged id moves before or
      after it depending on which half of the tile the pointer is in. */
  function reorderOver(e: DragEvent, section: Extract<DrawerSection, { kind: 'patches' }>) {
    if (canRefile(section)) return refileOver(e, section);
    if (!reorder || reorder.sectionKey !== section.key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const tile = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-reveal-id]');
    const overId = tile?.dataset.revealId;
    if (!tile || overId === undefined || overId === reorder.patchId) return;
    const overIndex = reorder.ids.indexOf(overId);
    if (overIndex < 0) return;
    const rect = tile.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const ids = reorder.ids.filter((id) => id !== reorder!.patchId);
    ids.splice(ids.indexOf(overId) + (after ? 1 : 0), 0, reorder.patchId);
    if (ids.some((id, i) => id !== reorder!.ids[i])) reorder.ids = ids;
  }

  function reorderDrop(e: DragEvent, section: Extract<DrawerSection, { kind: 'patches' }>) {
    if (canRefile(section)) return refileDrop(e, section);
    if (!reorder || reorder.sectionKey !== section.key) return;
    e.preventDefault();
    onReorderPatches(reorder.sectionKey, reorder.ids);
    reorder = null;
  }

  /** dragend from the tile: fires after a landed drop's commit (reorder is
      already null then) and on its own for a drag released elsewhere, which
      snaps the preview back by discarding it. */
  function endReorder() {
    reorder = null;
    refileKey = null;
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
      <!-- One patch section's tiles, shared between the accordion sections and
           the uncategorised row above them. -->
      {#snippet patchEntries(section: PatchSection)}
        {#each orderedEntries(section) as entry (entry.patch.id)}
          <!-- The wrapper exists for animate:flip, which only rides the
               immediate element child of a keyed each. It dims the tile in
               hand so the preview clearly shows the slot the drop would
               take. -->
          <div
            animate:flip={tileFlip}
            role="presentation"
            class={[
              'flex-none',
              reorder?.patchId === entry.patch.id && 'opacity-40 transition-opacity duration-120',
            ]}
          >
            <PatchTile
              patch={entry.patch}
              pluginId={pluginIdByName.get(entry.patch.pluginName)}
              revealed={revealedIds.has(entry.patch.id)}
              onDragStart={(payload) => {
                // A plain drag leaves for the rack, but stays armed for
                // the mid-drag Shift conversion (see convertOnShift).
                if (!filterActive) {
                  armed = { sectionKey: section.key, patchId: entry.patch.id };
                  window.addEventListener('dragover', convertOnShift);
                }
                onDragStart(payload);
              }}
              onDragEnd={() => {
                window.removeEventListener('dragover', convertOnShift);
                armed = null;
                reorder = null;
                refileKey = null;
                onDragEnd();
              }}
              onReorderStart={filterActive
                ? undefined
                : () => startReorder(section.key, entry.patch.id)}
              onReorderEnd={endReorder}
              onRename={(name) => onRenamePatch(entry.patch.id, name)}
              onSetCategory={(category) => onSetPatchCategory(entry.patch.id, category)}
              onDelete={() => onDeletePatch(entry.patch.id)}
              captureMissing={missingCaptures?.has(entry.patch.id) ?? false}
              onRepair={() => onRepairPatch?.(entry.patch.id)}
              onOpenTone={entry.patch.tone3000?.url && onOpenToneUrl
                ? () => onOpenToneUrl(entry.patch.tone3000!.url!)
                : undefined}
              onShowPackage={packageIdOf(entry.patch) && onShowPackage
                ? () => onShowPackage(packageIdOf(entry.patch)!)
                : undefined}
            />
          </div>
        {/each}
      {/snippet}

      <!-- The uncategorised patches, resolved in place: no heading, no
           accordion, always visible above the sections. The container still
           carries the section's reorder/refile handlers, so dragging within
           the row reorders it and a reorder drag from a section dropped here
           re-files the patch as uncategorised. -->
      {#if uncategorised}
        {@const section = uncategorised}
        <div
          class={[
            'flex flex-wrap items-start gap-2 border-b border-[var(--edge-hair)] px-3 pt-2.5 pb-2.5',
            refileKey === section.key && 'refile-target',
          ]}
          role="list"
          ondragover={(e) => reorderOver(e, section)}
          ondragleave={() => refileLeave(section)}
          ondrop={(e) => reorderDrop(e, section)}
        >
          {@render patchEntries(section)}
        </div>
      {/if}

      {#each sections as section (section.key)}
        {@const open = isOpen(section)}
        <section class="border-t border-[var(--edge-hair)] first:border-t-0">
          <h4>
            <button
              type="button"
              class={[
                'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[length:var(--drawer-font-heading)] font-semibold tracking-[.06em] text-muted uppercase transition-colors duration-120 hover:text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
                open && 'text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
                refileKey === section.key && 'refile-target',
              ]}
              onclick={() => selectSection(section)}
              aria-expanded={open}
              ondragover={(e) => refileOver(e, section)}
              ondragleave={() => refileLeave(section)}
              ondrop={(e) => refileDrop(e, section)}
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
              <span class="ml-auto pl-2 font-medium tracking-normal tabular-nums opacity-75"
                >{section.kind === 'patches'
                  ? section.entries.length
                  : section.groups.reduce(
                      (n, [, makerPlugins]) => n + makerPlugins.length,
                      0,
                    )}</span
              >
            </button>
          </h4>
          {#if open}
            <div
              class={[
                'px-3 pt-0.5 pb-2',
                section.kind === 'patches' ? 'flex flex-wrap items-start gap-2' : 'flex flex-col',
              ]}
              role={section.kind === 'patches' ? 'list' : undefined}
              transition:slide={sectionSlide}
              ondragover={section.kind === 'patches' ? (e) => reorderOver(e, section) : undefined}
              ondragleave={section.kind === 'patches' ? () => refileLeave(section) : undefined}
              ondrop={section.kind === 'patches' ? (e) => reorderDrop(e, section) : undefined}
            >
              {#if section.kind === 'patches'}
                {@render patchEntries(section)}
              {:else}
                <!-- The maker buckets as fixed sub-headings — the level the
                     accordion used to spend a section per vendor on. Plain
                     headings, not controls: the one Plugins section opens and
                     closes as a whole. -->
                {#each section.groups as [maker, makerPlugins] (maker)}
                  <h5
                    class="pt-2 pb-1.5 text-[length:var(--drawer-font-label)] font-semibold tracking-[.06em] text-muted/80 uppercase first:pt-1"
                  >
                    {maker}
                  </h5>
                  <div class="flex flex-wrap items-start gap-2" role="list">
                    {#each makerPlugins as plugin (plugin.id)}
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
                             carries (see BrowseTone3000Tile, PatchTile): one
                             mark that means "take hold of this". -->
                        <DotsSixVerticalIcon
                          size={14}
                          weight="bold"
                          class="flex-none text-muted opacity-60 transition-opacity group-hover:opacity-100"
                          aria-hidden="true"
                        />
                        {plugin.name}
                      </span>
                    {/each}
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
      {:else}
        {#if !uncategorised}
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
        {/if}
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
  /* Light: the app's cards are pure white a step above the chrome, but in here
     the chips sit *on* that near-white chrome, where white-on-white leaves the
     borders doing all the work. A step below the chrome instead — same value
     as PatchTile's and BrowseTone3000Tile's light blocks, which only the
     tiles the user has not coloured take (a tinted tile keeps its own mix
     over the normal white panel). */
  :global(:root[data-theme='light']) .plugin-chip {
    --color-panel: rgb(238 242 247 / 0.94);
  }
  /* Drag-ghost fix, same as PatchTile: Chromium snapshots a dragged element
     without isolating it from its parent, so the chrome behind the rounded
     corners rides into the ghost as opaque squares. A no-op transform gives
     the chip its own paint layer and the ghost keeps its transparency. */
  .plugin-chip {
    transform: translate(0, 0);
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

  /* The section a reorder drag would re-file into if released now: the same
     accent language as every drop zone, on the header so a closed section
     answers as well as an open one — and on the uncategorised row itself,
     which has no header. Element+class so it outranks the header's own
     text-colour utilities without an !important. */
  button.refile-target,
  div.refile-target {
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
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
