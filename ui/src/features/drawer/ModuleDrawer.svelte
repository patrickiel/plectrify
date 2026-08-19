<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { CaretRightIcon, DotsSixVerticalIcon } from 'phosphor-svelte';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { PluginScanState } from '../../lib/engine/EngineBridge';
  import type { BlacklistedPlugin, Patch, PluginInfo } from '../../lib/engine/types';
  import type { CatalogueState } from '../../lib/engine/catalogue';
  import {
    isSectionOnBranch,
    packageDrawerItems,
    packageIdForPatch,
    parentSectionKey,
  } from '../../lib/engine/drawerGroups';
  import { DrawerDrag } from './drawerDrag.svelte';
  import {
    buildDrawerTree,
    firstSectionWith,
    isTone3000Root,
    isUncategorised,
    NO_SECTION,
    resolveOpenKey,
    type DrawerSection,
    type PatchNode,
  } from './drawerTree';
  import { onRevealRequest, type RevealRequest } from './reveal';
  import { DrawerResize } from './drawerResize.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import DrawerShelf from './DrawerShelf.svelte';
  import PatchTile from './PatchTile.svelte';
  import Tone3000Logo from '../tone3000/Tone3000Logo.svelte';

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
        a reorder drag lands — in the section it started in, or in the one that
        adopted it on the way. */
    patchOrder: Record<string, string[]>;
    onReorderPatches: (sectionKey: string, patchIds: string[]) => void;
    /** File a patch under a heading. A drag that lands in another category
        reports this *and* onReorderPatches, in that order: one gesture says
        both which section the patch belongs to and where in it. */
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

  /** Declared before `sunk`, which reads it. Props cross as getters and
      callbacks as wrappers — never captured values, which would freeze at
      construction. */
  const drag = new DrawerDrag({
    patches: () => patches,
    patchOrder: () => patchOrder,
    sections: () => tree.allSections,
    lowered: () => lowered,
    isOpen: (section) => isOpen(section),
    onSetOpenSection: (key) => onSetOpenSection(key),
    onSetPatchCategory: (patchId, category) => onSetPatchCategory(patchId, category),
    onReorderPatches: (sectionKey, patchIds) => onReorderPatches(sectionKey, patchIds),
    onRackDragEnd: () => onDragEnd(),
  });

  /** Down to the shelf, whether the user parked it there or a drag out of the
      drawer is holding it out of the way. A live reorder overrides the
      lowering: a rack drag converted mid-flight needs the list it is
      reordering back on screen, and Rack keeps `lowered` up until the drag
      ends. The user's own collapse is not overridden by either — that one
      they parked deliberately. */
  const sunk = $derived((collapsed || (lowered && !drag.dragBack)) && drag.reorder === null);
  /** Constructed after `sunk`, which it reads. */
  const resize = new DrawerResize({
    collapsed: () => collapsed,
    height: () => height,
    maxHeight: () => maxHeight,
    sunk: () => sunk,
    onSetHeight: (px) => onSetHeight(px),
    onSetCollapsed: (next) => onSetCollapsed(next),
  });

  /** pluginName -> plugin id, for making a patch tile draggable (and dimming
      the ones whose plugin is not installed). */
  const pluginIdByName = $derived(new Map(plugins.map((p) => [p.name, p.id])));

  /** Everything the list draws: the filtered patch tree, the uncategorised row
      hoisted out above it, the plugins section, and the depth-first flat view
      the reveal, the reorder lookup and the stale-key resolution walk. Built in
      one pure pass — see drawerTree.ts. */
  const tree = $derived(buildDrawerTree({ patches, plugins, packages: catalogue.items, filter }));

  const effectiveOpenKey = $derived(resolveOpenKey(openSection, tree));

  /** Open means on the open branch: the stored key names the deepest open
      node, and every ancestor of it is open with it. A filter holds every
      surviving section open, because a match hidden behind a collapsed
      heading reads as no match at all; clicks while filtering persist nothing
      (see selectSection), so clearing the filter returns to the chosen one. */
  function isOpen(section: DrawerSection): boolean {
    if (filterActive) return true;
    const open = effectiveOpenKey;
    return open !== undefined && isSectionOnBranch(section.key, open);
  }

  /** A closed row opens (with its ancestors, by the rule above); an open one
      closes its branch, handing the open state back to its parent so the
      levels above stay where they were. */
  function selectSection(section: DrawerSection) {
    if (filterActive) return;
    if (!isOpen(section)) {
      onSetOpenSection(section.key);
      return;
    }
    onSetOpenSection(
      (section.kind === 'patches' ? parentSectionKey(section.path) : undefined) ?? NO_SECTION,
    );
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
      const hit = firstSectionWith(tree.allSections, wanted);
      if (hit && hit.key !== effectiveOpenKey && !isUncategorised(hit)) onSetOpenSection(hit.key);
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
      drag.destroy();
    };
  });

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
    !resize.resizing && 'drawer-animate',
  ]}
  style:height="{resize.shownHeight}px"
  role="region"
  aria-label="Module drawer"
  {...drag.rootAttrs}
>
  <!-- The lid, and the resize band: it reports back the height it measures,
       which is exactly what a collapsed drawer is tall. -->
  <DrawerShelf
    shelfAttrs={resize.shelfAttrs}
    onResizeKeydown={resize.keydown}
    onMeasure={(px) => (resize.shelfHeight = px)}
    {collapsed}
    shownHeight={resize.shownHeight}
    bind:filter
    {blacklisted}
    {onManageBlacklist}
    {scanLabel}
    {scanning}
    {onScan}
    {onBrowseTone3000}
    {namPluginId}
    {onDragStart}
    {onDragEnd}
    {browseRevealed}
  />

  <!-- Kept mounted while sunk so the height can animate between the shelf and
       the stored height — and so a drag whose source tile sits in here never
       loses its source node mid-gesture. inert only for the user's own
       collapse: while `lowered` a drag from in here is live, and making the
       source's ancestor inert mid-drag aborts the drag outright. It is the
       list alone, never the shelf: the header's controls are the reason the
       shelf stays. -->
  <div class="relative min-h-0 flex-1 overflow-y-auto pb-3" bind:this={listEl} inert={collapsed}>
    {#snippet patchEntries(section: PatchNode)}
      {#each drag.orderedEntries(section) as entry (entry.patch.id)}
        {@const packageId = packageIdOf(entry.patch)}
        <!-- The wrapper exists for animate:flip, which only rides the
             immediate element child of a keyed each. It dims the tile in hand
             so the preview shows the slot the drop would take. -->
        <div
          animate:flip={tileFlip}
          role="presentation"
          class={[
            'flex-none',
            drag.reorder?.patchId === entry.patch.id &&
              'opacity-40 transition-opacity duration-120',
          ]}
        >
          <PatchTile
            patch={entry.patch}
            pluginId={pluginIdByName.get(entry.patch.pluginName)}
            revealed={revealedIds.has(entry.patch.id)}
            onDragStart={(payload) => {
              // A plain drag leaves for the rack, but stays armed for the
              // mid-drag conversion — coming back over the drawer.
              drag.armPlainDrag(section.key, entry.patch.id, !filterActive);
              onDragStart(payload);
            }}
            onDragEnd={() => drag.endPlainDrag()}
            onReorderStart={filterActive
              ? undefined
              : () => drag.startReorder(section.key, entry.patch.id)}
            onReorderEnd={() => drag.endReorder()}
            onRename={(name) => onRenamePatch(entry.patch.id, name)}
            onSetCategory={(category) => onSetPatchCategory(entry.patch.id, category)}
            onDelete={() => onDeletePatch(entry.patch.id)}
            captureMissing={missingCaptures?.has(entry.patch.id) ?? false}
            onRepair={() => onRepairPatch?.(entry.patch.id)}
            onOpenTone={entry.patch.tone3000?.url && onOpenToneUrl
              ? () => onOpenToneUrl(entry.patch.tone3000!.url!)
              : undefined}
            onShowPackage={packageId && onShowPackage ? () => onShowPackage(packageId) : undefined}
          />
        </div>
      {/each}
    {/snippet}

    <!-- The uncategorised patches, resolved in place: no heading, no
           accordion, always visible above the sections. The container still
           carries the section's reorder/refile handlers, so dragging within
           the row reorders it, and a drag carried in from a section is adopted
           here exactly as it would be by any other — the drop un-files the
           patch and places it in the row in one go. -->
    {#if tree.uncategorised}
      {@const section = tree.uncategorised}
      <div
        class={[
          'flex flex-wrap items-start gap-2 border-b border-[var(--edge-hair)] px-3 pt-2.5 pb-2.5',
          drag.refileKey === section.key && 'refile-target',
        ]}
        role="list"
        ondragover={(e) => drag.reorderOver(e, section)}
        ondragleave={() => drag.refileLeave(section)}
        ondrop={(e) => drag.reorderDrop(e, section)}
      >
        {@render patchEntries(section)}
      </div>
    {/if}

    <!-- Shared by the patch rows and the Plugins section. `refile` carries the
         drop handlers a patch row needs and is left off the Plugins one, which
         nothing can be filed into. A snippet rather than a component: the
         `.refile-target` rule below also dresses the uncategorised row, and one
         scoped selector cannot span two components. -->
    {#snippet sectionHeader(
      section: DrawerSection,
      depth: number,
      open: boolean,
      refile?: HTMLButtonAttributes,
    )}
      <h4>
        <button
          type="button"
          class={[
            'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[length:var(--drawer-font-heading)] font-semibold tracking-[.06em] text-muted uppercase transition-colors duration-120 hover:text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
            open && 'text-[color-mix(in_srgb,var(--color-ink)_80%,transparent)]',
            drag.refileKey === section.key && 'refile-target',
          ]}
          style:padding-left={depth > 0 ? `${0.75 + depth * 0.75}rem` : undefined}
          onclick={() => selectSection(section)}
          aria-expanded={open}
          {...refile}
        >
          <CaretRightIcon
            size={11}
            weight="bold"
            class={[
              'flex-none transition-[rotate] duration-130 ease-[cubic-bezier(.25,.8,.25,1)]',
              open && 'rotate-90',
            ]}
          />
          {#if isTone3000Root(section, depth)}
            <!-- The wordmark is the title: its own alt text names the
                   section, so the button reads the same to a screen reader
                   as every other heading does. -->
            <Tone3000Logo height={12} class="shrink-0" />
          {:else}
            <span class="truncate">{section.title}</span>
          {/if}
          <span class="ml-auto pl-2 font-medium tracking-normal tabular-nums opacity-75"
            >{section.count}</span
          >
        </button>
      </h4>
    {/snippet}

    {#snippet patchNodeRow(node: PatchNode, depth: number)}
      {@const open = isOpen(node)}
      <!-- Only a top-level row is ruled off: the hairlines divide the drawer's
           categories, and repeating them inside one would draw the subsections
           as a second list rather than as part of it. -->
      <section
        class={depth === 0 ? 'border-t border-[var(--edge-hair)] first:border-t-0' : undefined}
      >
        {@render sectionHeader(node, depth, open, {
          ondragover: (e) => drag.refileOver(e, node),
          ondragleave: () => drag.refileLeave(node),
          ondrop: (e) => drag.refileDrop(e, node),
        })}
        {#if open}
          <div transition:slide={sectionSlide}>
            {#if node.entries.length > 0}
              <div
                class="flex flex-wrap items-start gap-2 px-3 pt-0.5 pb-2"
                style:padding-left={depth > 0 ? `${0.75 + depth * 0.75}rem` : undefined}
                role="list"
                ondragover={(e) => drag.reorderOver(e, node)}
                ondragleave={() => drag.refileLeave(node)}
                ondrop={(e) => drag.reorderDrop(e, node)}
              >
                {@render patchEntries(node)}
              </div>
            {/if}
            {#each node.children as child (child.key)}
              {@render patchNodeRow(child, depth + 1)}
            {/each}
          </div>
        {/if}
      </section>
    {/snippet}

    {#each tree.treeRoots as node (node.key)}
      {@render patchNodeRow(node, 0)}
    {/each}

    {#if tree.pluginsSection}
      {@const section = tree.pluginsSection}
      {@const open = isOpen(section)}
      <section class="border-t border-[var(--edge-hair)] first:border-t-0">
        {@render sectionHeader(section, 0, open)}
        {#if open}
          <div class="flex flex-col px-3 pt-0.5 pb-2" transition:slide={sectionSlide}>
            <!-- Plain headings, not controls: the one Plugins section opens
                 and closes as a whole. -->
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
          </div>
        {/if}
      </section>
    {/if}

    {#if tree.allSections.length === 0}
      <p class="px-3 py-4 text-xs text-muted">
        {#if filterActive}
          No matches.
        {:else if plugins.length === 0}
          No VST3 plugins found. Scan for plugins, or install a starter set from the Packages panel.
        {:else}
          Nothing here yet. Save a patch from a module's patch menu, or install one from the
          Packages panel.
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  /* Same chrome family as the toolbar and status bar: a hairline frame over
     a blurred panel wash, rounded at the top like a sheet rising from the
     status bar, so the drawer reads as app furniture rather than as part of
     the rack canvas it borders.

     The class is also a contract with DrawerResize, which reads the chrome
     zoom off this element by name — zoom does not inherit, so the shelf's own
     computed value is always 1. */
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

  /* The section a reorder drag would file the patch under if released now: the
     same accent language as every drop zone, on the header so a closed section
     answers as well as an open one — and it stays lit once that section has
     adopted the drag, so the heading above the tiles stepping aside says which
     category they belong to. Also on the uncategorised row itself, which has
     no header. Element+class so it outranks the header's own
     text-colour utilities without an !important. (Both are drawn by this
     component — the header is a snippet, not a child — so one scoped rule
     reaches them.) */
  button.refile-target,
  div.refile-target {
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  }

  /* Click-collapse, keyboard steps and the reopen all tween; a live drag
     switches this off (see DrawerResize's `resizing`) so the edge tracks the
     pointer 1:1. */
  .drawer-animate {
    transition: height 0.2s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer-animate {
      transition: none;
    }
  }
</style>
