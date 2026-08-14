<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { slide } from 'svelte/transition';
  import {
    ArrowSquareOutIcon,
    CaretRightIcon,
    DotsThreeVerticalIcon,
    TrashIcon,
    XIcon,
  } from 'phosphor-svelte';
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import type { Patch, PluginInfo, RackModule } from '../../lib/engine/types';
  import { packageDrawerItems } from '../../lib/engine/drawerGroups';
  import { revealPackageInDrawer } from '../drawer/reveal';
  import {
    EMPTY_CATALOGUE_STATE,
    describeInstallError,
    groupByCategory,
    isUpdatable,
    bundlePendingBytes,
    bundlePendingIds,
    dependencyName,
    queueInstallRows,
    resolveInstallIds,
    reduceInstallProgress,
    settleInstallRun,
    stageForItem,
    type CataloguePackage,
    type CatalogueBundle,
    type CatalogueLink,
    type CategoryNode,
    type InstallRunState,
    type InstallStage,
    type CatalogueState,
  } from '../../lib/engine/catalogue';
  import Button from '../../lib/components/Button.svelte';
  import Card from '../../lib/components/Card.svelte';
  import IconButton from '../../lib/components/IconButton.svelte';
  import Popover from '../../lib/components/Popover.svelte';
  import RowButton from '../../lib/components/RowButton.svelte';
  import { createReveal } from '../../lib/components/reveal.svelte';
  import { tooltip } from '../../lib/components/tooltip.svelte';
  import { noteCatalogueArrived, refreshPhase } from './refreshState.svelte';

  interface Props {
    engine: EngineBridge;
  }

  let { engine }: Props = $props();

  let catalogue = $state<CatalogueState>(EMPTY_CATALOGUE_STATE);
  /** Live per-row progress from the event stream, reconciled against
      `catalogue` (which is disk truth) whenever a run ends. */
  let run = $state<InstallRunState>({});
  /** Which bundle cards have their contents unfolded, by bundle id. A plain
      record rather than one flag: the catalogue decides how many bundles there
      are, and each card's disclosure is its own. */
  let openBundles = $state<Record<string, boolean>>({});
  // The unfolding animates, so the list is rendered conditionally rather than
  // by a native <details> — which has no way to transition its own contents.
  const reveal = createReveal();
  /** The one row whose menu is open. A row is a name, a purpose and one action;
      everything else is a question asked about a single package, so it is
      answered on demand rather than repeated down every row. */
  let openMenuId = $state<string | null>(null);
  // What an installed package actually put in the module drawer. Subscribed
  // here rather than passed down: they answer a question about this panel's own
  // rows — whether a row leads anywhere — and both replay their last value, so
  // a second subscriber costs nothing.
  let patches = $state<Patch[]>([]);
  let plugins = $state<PluginInfo[]>([]);
  /** The live chain, for one question only: is this package's plugin playing
      right now? Removing one that is has consequences worth stating before the
      click rather than discovering afterwards. */
  let rack = $state<RackModule[]>([]);

  // The engine reference is stable for the panel's life, so these subscribe
  // once at mount rather than re-running on every state change.
  onMount(() =>
    engine.subscribeCatalogue((next) => {
      catalogue = next;
      // The final non-busy push is disk truth even when installFinished was
      // dropped while the WebView was hidden. Do not let stale queued or
      // downloading stream state keep overriding it indefinitely.
      if (!next.busy) {
        run = settleInstallRun(run);
      }
      // A fresh catalogue is the only sign a refresh finished — the request
      // carries no reply of its own.
      noteCatalogueArrived();
    }),
  );
  onMount(() =>
    engine.subscribeInstallProgress((event) => {
      run = reduceInstallProgress(run, event);
    }),
  );
  onMount(() =>
    engine.subscribeInstallFinished((result) => {
      // Rows render from disk state from here on; failures stay so their Retry
      // is still reachable.
      run = settleInstallRun(run);

      // The other half of an install, without being asked for: what was just
      // fetched is shown where it can be used. Only what the user clicked, and
      // only if it actually landed — the drawer holds the request until the
      // rescan that follows has put the plugin in the list, so this lands a
      // few seconds later, on a list that has it.
      const id = revealWhenInstalled;
      revealWhenInstalled = null;
      if (id !== null && result.installed.includes(id)) showInDrawer(id);
    }),
  );

  onMount(() => engine.subscribePatches((next) => (patches = next)));
  onMount(() => engine.subscribePlugins((next) => (plugins = next)));
  onMount(() => engine.subscribeRack((next) => (rack = next)));

  // Opening the panel re-resolves the catalogue: someone who has just come
  // online should not have to restart to see the current list.
  onMount(() => engine.refreshCatalogue());

  const stale = $derived(catalogue.source === 'cache' || catalogue.source === 'none');
  const installedCount = $derived(catalogue.items.filter((item) => item.installed).length);
  const updatableCount = $derived(catalogue.items.filter(isUpdatable).length);

  /** What the status line says once a check has run. "Up to date" is the answer
      people press Refresh for, and it is the one a silent button never gave. */
  const refreshMessage = $derived.by(() => {
    if (refreshPhase() === 'checking') return 'Checking…';
    if (refreshPhase() !== 'checked') return '';
    if (stale) return "Couldn't reach the server";
    if (updatableCount === 0) return 'Up to date';
    return `${updatableCount} update${updatableCount === 1 ? '' : 's'} available`;
  });

  // One card per top-level catalogue category, titled by it, with a subsection
  // for every deeper heading the catalogue names — for the packages on offer
  // and for the outbound links alike. The panel names none of these sections
  // itself and decides none of the nesting: what is worth offering changes with
  // the catalogue, and a heading compiled into the app could only ever describe
  // the mix that existed the day it shipped.
  const packageGroups = $derived(groupByCategory(catalogue.items));
  const linkGroups = $derived(groupByCategory(catalogue.links));

  // Order matters: what these are, how they reach you, the hosted exception,
  // then the two things people actually ask about (models, uninstall).
  const noticeParagraphs = $derived(
    [
      catalogue.notices.summary,
      catalogue.notices.fetched,
      catalogue.notices.hosted,
      catalogue.notices.models,
      catalogue.notices.uninstall,
    ].filter((text) => text.length > 0),
  );

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  /** The package to show in the drawer when this run lands, or null. One
      package only: a bundle installs a folder's worth at once and there is no
      "that one" to scroll to, and a dependency dragged in behind a patch is
      not what was clicked either. Cleared as it is spent, so a later run that
      the user started some other way never inherits it. */
  let revealWhenInstalled: string | null = null;

  function install(ids: string[], bundleId?: string): void {
    if (ids.length === 0) return;
    revealWhenInstalled = bundleId === undefined && ids.length === 1 ? ids[0] : null;
    // Mark the rows immediately: the installer works through them in order, so
    // without this the later ones sit on "missing" while their turn comes. The
    // dependencies are marked too — the engine adds them to the same run, and a
    // row downloading under a "missing" label reads as a bug.
    run = queueInstallRows(run, resolveInstallIds(ids, catalogue.items));
    engine.installPackages(ids, bundleId);
  }

  /** How many modules in the live chain are hosting a plugin this package
      installed. Matched through `PluginInfo.packageId`, which the engine joins
      against the install markers — so this counts only plugins Plectrify put
      there, never a same-named copy the user installed themselves. */
  function modulesUsing(id: string): number {
    const names = new Set(plugins.filter((p) => p.packageId === id).map((p) => p.name));
    return names.size === 0 ? 0 : rack.filter((m) => names.has(m.name)).length;
  }

  /** The package whose removal is waiting on an answer, and how many modules
      that answer costs. Only ever asked when the plugin is in the rack: for
      everything else the click stays immediate, because it is reversible from
      the row it was clicked on. */
  let confirmingRemoveId = $state<string | null>(null);

  function remove(id: string): void {
    if (confirmingRemoveId !== id && modulesUsing(id) > 0) {
      confirmingRemoveId = id;
      return;
    }

    confirmingRemoveId = null;
    openMenuId = null;
    engine.uninstallPackages([id]);
  }

  /** The bundle button's one line: the verb, then what it costs. Three cases —
      never installed, a newer edition published, and the in-between where some
      of the bundle's plugins are present and the rest are not.

      The verb follows what is on disk, not the install marker. installedVersion
      records the version the bundle was last taken WHOLE at, and nothing clears
      it when the plugins are uninstalled one by one afterwards — so a bundle
      whose members have all been removed would otherwise offer to "update"
      nothing, which is the one thing the click cannot do. Every member missing
      is an install however the marker reads. */
  function bundleLabel(bundle: CatalogueBundle): string {
    const pending = bundlePendingIds(bundle, catalogue, run);
    const size = formatBytes(bundlePendingBytes(bundle, catalogue, run));
    const nothingInstalled = bundle.missingPackageIds.length === bundle.packageIds.length;
    const verb =
      bundle.installedVersion === '' || nothingInstalled
        ? 'Install bundle'
        : bundle.updateAvailable
          ? 'Update bundle'
          : `Install ${pending.length} missing`;
    return size ? `${verb} · ~${size}` : verb;
  }

  /** What a bundle holds, in the order it names them, each with where it stands.
      The bundle's button says what installing would do in total; this says which
      members that total is actually about — otherwise "Update bundle · ~2 MB"
      over six names gives no clue which of the six is the 2 MB.

      An id with no row is dropped rather than shown raw: it means the bundle
      names something this catalogue no longer publishes. One this platform is
      not offered says so instead of "Missing": the button below skips it, and a
      name listed as missing under a bundle that is done installing would read
      as something gone wrong. */
  function bundleEntries(
    bundle: CatalogueBundle,
  ): { id: string; name: string; state: 'installed' | 'outdated' | 'missing' | 'unavailable' }[] {
    const byId = new Map(catalogue.items.map((item) => [item.id, item]));
    const missing = new Set(bundle.missingPackageIds);
    const outdated = new Set(bundle.outdatedPackageIds);

    return bundle.packageIds.flatMap((id) => {
      const item = byId.get(id);
      if (item === undefined) return [];

      const pending = missing.has(id) || outdated.has(id);
      const state =
        !item.available && pending
          ? 'unavailable'
          : missing.has(id)
            ? 'missing'
            : outdated.has(id)
              ? 'outdated'
              : 'installed';
      return [{ id, name: item.name, state }];
    });
  }

  function progressPercent(id: string): number {
    const row = run[id];
    if (!row || row.total <= 0) return 0;
    return Math.min(100, Math.round((row.received / row.total) * 100));
  }

  const BUSY_STAGES: ReadonlySet<InstallStage> = new Set([
    'queued',
    'downloading',
    'verifying',
    'extracting',
    'installing',
  ]);

  /** How full the row's bar is. A queued row has done nothing yet, so it sits
      empty — a full bar beside "Waiting" said the opposite of the word next to
      it. Once the bytes are in, the stages after downloading keep it full: the
      download is the only part with a measurable fraction, and dropping back to
      empty for verify and extract would read as progress lost. */
  function barPercent(id: string, stage: InstallStage): number {
    if (stage === 'queued') return 0;
    return stage === 'downloading' ? progressPercent(id) : 100;
  }

  /** What the progress line says. Downloading is the only stage with a number
      worth showing; the rest are short enough that a word beats a bar label. */
  function stageLabel(id: string, stage: InstallStage): string {
    if (stage === 'queued') return 'Waiting';
    if (stage === 'downloading') return `${progressPercent(id)}%`;
    return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  }

  /** The package a click on this row would fetch as well, or ''. Named on the
      row only while it is actually missing: once it is installed, that this
      patch needs it is a fact about the catalogue rather than about the button,
      and facts live in the menu. */
  function alsoInstalls(item: CataloguePackage): string {
    const dependency = catalogue.items.find((entry) => entry.id === item.dependsOn);
    return dependency && !dependency.installed ? dependency.name : '';
  }

  /** What this package put in the module drawer — its plugins, or the patches
      a pack installed. Empty for everything the drawer cannot show: a package
      not installed yet, and content like IRs and captures, which a plugin opens
      rather than the drawer listing. */
  function drawerItems(item: CataloguePackage): string[] {
    if (!item.installed) return [];
    const { patchIds, pluginIds } = packageDrawerItems(item.id, patches, plugins);
    return [...patchIds, ...pluginIds];
  }

  /** The other half of an install: where the thing you just fetched turns up.
      The drawer only exists in edit mode, so this turns it on — the panel is in
      the sidebar and the drawer at the foot of the rack, so both stay visible
      and nothing the user was reading is replaced. */
  function showInDrawer(packageId: string): void {
    engine.setAppSettings({ editMode: true });
    revealPackageInDrawer(packageId);
  }

  /** What the row's tooltip promises, named for what is actually down there. */
  function showInDrawerTip(count: number, item: CataloguePackage): string {
    const noun = item.kind === 'plugin' ? 'plugin' : 'patch';
    return count === 1
      ? `Show this ${noun} in the module drawer`
      : `Show these ${count} ${noun}s in the module drawer`;
  }

  /** The version line in a row's details: what is on disk, and what installing
      would move it to. */
  function versionText(item: CataloguePackage): string {
    if (!item.installed) return item.version;
    if (item.updateAvailable) return `${item.installedVersion} → ${item.version}`;
    return item.installedVersion || item.version;
  }
</script>

<!-- Cards, not a card per plugin — the same language as the settings and info
     panels: one surface per group, the card's border doing the separating, and
     each plugin one row inside it. Order follows what someone with an empty
     rack does: take the bundle, or pick plugins one at a time, then go and find
     the captures and IRs they play. The licence disclosure sits last and
     folded, where it is available without being the loudest thing on screen. -->
{#snippet cardHeader(title: string, action?: Snippet)}
  <div class="flex items-center justify-between gap-2 px-[.6rem] pt-[.35rem] pb-[.1rem]">
    <span class="text-[.625rem] font-semibold tracking-[.14em] text-muted uppercase">{title}</span>
    {#if action}{@render action()}{/if}
  </div>
{/snippet}

<!-- A subsection heading inside a category card — "Reverb" under "Effects".
     Quieter than the card's own eyebrow and ruled off above it, so a card with
     subsections still reads as one section subdivided rather than as several
     cards run together. Deeper levels indent: the catalogue decides how far a
     path goes, and two headings at different depths drawn identically would say
     the tree was flat. -->
{#snippet subsectionHeader(title: string, depth: number)}
  <div
    class="mt-[.15rem] border-t border-ink/10 pt-[.3rem] pr-[.6rem] pb-[.05rem]"
    style:padding-left="calc(.6rem + {(depth - 1) * 0.55}rem)"
  >
    <span class="text-[.6rem] font-semibold tracking-[.12em] text-muted/65 uppercase">
      {title}
    </span>
  </div>
{/snippet}

<!-- The catalogue's own status line, above the sections rather than inside the
     first of them: the count spans every category, so sitting in the "Amps"
     card made it read as belonging to Amps. Refresh acts on the whole
     catalogue too, and lives in the panel's title bar — see ToolSidebar. -->
{#snippet catalogueBar()}
  <div class="flex items-center justify-between gap-2 px-[.15rem]">
    <span class="text-[.7rem] text-muted">
      {installedCount} of {catalogue.items.length} installed
    </span>
    <!-- The outcome of the title bar's Refresh. Announced, because the change
         it reports may be nothing changing at all — which is exactly the case
         a sighted user learns from the words and a screen-reader user would
         otherwise never hear. -->
    <span
      class="text-[.7rem] text-muted"
      class:text-accent={refreshPhase() === 'checked' && !stale && updatableCount > 0}
      role="status"
      aria-live="polite"
    >
      {refreshMessage}
    </span>
  </div>
  {#if stale}
    <!-- A stale catalogue must never read as the current one. Here rather than
         on a section, because it is the whole list that may be behind. -->
    <p class="px-[.15rem] text-[.7rem] leading-[1.35] text-warn">
      {catalogue.error || "Showing a saved list — couldn't reach the server."}
    </p>
  {/if}
{/snippet}

<!-- One row per package: what it is called, what it is for, and the single
     action it offers. Everything else about it — version, size, licence,
     project link, and Remove — lives behind the row's menu, so seven rows read
     as a list rather than as seven small forms.

     Version and size are in the menu and nowhere else. Showing them on the row
     as well put the same two facts on screen twice, and neither changes what
     you would click: whether a package is installed is already said by whether
     the row offers Install. -->
<!-- What a row says it is, shared by the two wrappers above: an installed
     package's block is a button into the drawer, everything else's is inert
     text. `group-hover` only bites under the button — nothing else in the row
     carries the group class — so the same markup reads as a link there and as
     a label here. -->
{#snippet rowIdentity(item: CataloguePackage, unavailable: boolean, busy: boolean)}
  <div
    class={[
      'truncate text-[.8rem] font-medium transition-colors',
      unavailable ? 'text-ink/45' : 'text-ink group-hover:text-accent',
    ]}
  >
    {item.name}
  </div>
  <div class={['truncate text-[.7rem]', unavailable ? 'text-muted/60' : 'text-muted']}>
    {item.purpose}
  </div>
  {#if !busy && !item.installed}
    {@const dependency = alsoInstalls(item)}
    {#if dependency}
      <!-- A patch is nothing without the plugin it was built for, so installing
           one fetches that plugin too. Said here rather than left to the menu:
           it changes what the button next to it does, and finding out
           afterwards is finding out too late. -->
      <div class="truncate text-[.65rem] text-muted/70">Also installs {dependency}</div>
    {/if}
  {/if}
{/snippet}

{#snippet packageRow(item: CataloguePackage)}
  {@const stage = stageForItem(item, run)}
  {@const busy = BUSY_STAGES.has(stage)}
  <!-- Nothing to install on this OS and nothing on disk. An installed copy
       keeps its normal treatment: it works regardless of what the catalogue
       can offer this platform today. -->
  {@const unavailable = !item.available && !item.installed}
  {@const revealable = drawerItems(item)}
  <div class="flex flex-col">
    <div class="flex items-center gap-1 pr-[.35rem]">
      <!-- An installed package's name is a way back to it: the drawer is where
           it can actually be used, and finding one plugin among a scanned
           folder of them is the tedious part of having just installed it. Only
           where there is something to show — a row that led nowhere would be
           worse than no affordance at all. -->
      {#if revealable.length > 0}
        <button
          type="button"
          class="group min-w-0 flex-1 cursor-pointer rounded-md px-[.6rem] py-[.4rem] text-left hover:bg-control-hover focus-visible:[outline:var(--focus-ring)] focus-visible:outline-offset-(--focus-out)"
          onclick={() => showInDrawer(item.id)}
          {@attach tooltip(showInDrawerTip(revealable.length, item))}
        >
          {@render rowIdentity(item, unavailable, busy)}
        </button>
      {:else}
        <div class="min-w-0 flex-1 px-[.6rem] py-[.4rem]">
          {@render rowIdentity(item, unavailable, busy)}
        </div>
      {/if}

      {#if busy}
        <IconButton
          label="Cancel the install"
          tip="Cancel"
          tipPlacement="left"
          tone="warn"
          onclick={() => engine.cancelInstall()}
        >
          <XIcon size={13} />
        </IconButton>
      {:else if stage === 'failed' && item.available}
        <!-- Not offered for a package this platform has no payload for: an
             install it could only have reached as a bundle member or a
             dependency failed for a reason retrying cannot change. The
             explanation below the row still stands. -->
        <Button size="sm" disabled={catalogue.busy} onclick={() => install([item.id])}>
          Retry
        </Button>
      {:else if isUpdatable(item)}
        <Button
          size="sm"
          tone="accent"
          disabled={catalogue.busy}
          tip="Update to {item.version}"
          tipPlacement="left"
          onclick={() => install([item.id])}
        >
          Update
        </Button>
      {:else if unavailable}
        <!-- No payload for this OS in the catalogue. The row stays: hiding
             it would make the catalogue look quietly thinner per platform,
             and its licence and project links still answer questions. The
             engine computes this — the page never learns platform names. -->
        <span class="shrink-0 pr-1 text-[.65rem] whitespace-nowrap text-muted/70">
          Not available for this OS
        </span>
      {:else if !item.installed}
        <Button
          size="sm"
          tone="accent"
          disabled={catalogue.busy}
          onclick={() => install([item.id])}
        >
          Install
        </Button>
      {/if}

      {@render packageMenu(item)}
    </div>

    {#if busy}
      <div class="flex items-center gap-2 pr-[.6rem] pb-[.4rem] pl-[1.55rem]">
        <div class="h-0.75 min-w-0 flex-1 overflow-hidden rounded-full bg-control-on">
          <div
            class="h-full bg-accent transition-[width] duration-200"
            style:width="{barPercent(item.id, stage)}%"
          ></div>
        </div>
        <span class="shrink-0 font-mono text-[.625rem] text-muted tabular-nums">
          {stageLabel(item.id, stage)}
        </span>
      </div>
    {:else if stage === 'failed'}
      <p class="pr-[.6rem] pb-[.4rem] pl-[1.55rem] text-[.7rem] leading-[1.35] text-warn">
        {describeInstallError(run[item.id]?.error)}
      </p>
    {/if}
  </div>
{/snippet}

<!-- Everything a row does not need to shout: the facts, the two outbound
     links, and Remove. One menu rather than a caret for the facts and a
     separate icon for the action — they are the same question ("what is this
     and what can I do with it?") asked twice. -->
{#snippet packageMenu(item: CataloguePackage)}
  <Popover
    bind:open={() => openMenuId === item.id, (next) => (openMenuId = next ? item.id : null)}
    maxHeight={320}
    gap={4}
    panelClass="w-56"
    ariaHasPopup="menu"
  >
    {#snippet trigger(props)}
      <!-- A step up from the default row-action size: this is the only way into
           everything a row no longer shows, so it has to be an obvious target
           rather than a hairline of dots.

           No tooltip: a "More" bubble over a menu button says nothing the dots
           don't, and it lands right where the menu itself is about to open. The
           empty `tip` suppresses it while `label` still names the button for
           screen readers. -->
      <IconButton {...props} size="sm" label="More about {item.name}" tip="">
        <DotsThreeVerticalIcon size={18} weight="bold" />
      </IconButton>
    {/snippet}

    <dl
      class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[.15rem] px-3 py-2 text-[.7rem] text-muted"
    >
      <dt>Version</dt>
      <dd class="m-0 truncate font-mono text-ink/80 tabular-nums">{versionText(item)}</dd>
      {#if item.downloadBytes > 0}
        <dt>Download</dt>
        <dd class="m-0 font-mono text-ink/80 tabular-nums">{formatBytes(item.downloadBytes)}</dd>
      {/if}
      <dt>Licence</dt>
      <dd class="m-0 truncate text-ink/80">{item.licenseId}</dd>
      {#if item.dependsOn}
        <!-- Which package this one is for. Always shown, installed or not: the
             row above drops the line once the dependency is present, and "what
             plugin does this patch belong to" outlives that. -->
        <dt>Needs</dt>
        <dd class="m-0 truncate text-ink/80">{dependencyName(item, catalogue.items)}</dd>
      {/if}
      {#if item.dir}
        <!-- Content unpacks somewhere the user may want to point a plugin at,
             so it is worth naming; a plugin's directory is the managed one the
             panel already reports once at the foot. -->
        <dt>Folder</dt>
        <dd class="m-0 truncate text-ink/80" title={item.dir}>{item.dir}</dd>
      {/if}
      {#if item.selfHosted}
        <dt>Hosted by</dt>
        <dd class="m-0 text-ink/80">Plectrify</dd>
      {/if}
    </dl>

    {#if !item.available}
      <p class="m-0 px-3 pb-2 text-[.68rem] leading-[1.35] text-muted">
        The catalogue has no build of this package for this computer's operating system.
      </p>
    {/if}

    {#if item.unlisted}
      <!-- Installed but gone from the catalogue: it keeps working, so say that
           rather than dropping the row and leaving an unexplained plugin in the
           module drawer. -->
      <p class="m-0 px-3 pb-2 text-[.68rem] leading-[1.35] text-muted">
        No longer offered, but still installed.
      </p>
    {/if}

    <!-- A flex column, so each RowButton's own `flex-1` has something to
         stretch against: left to a plain block the rows shrink-wrap their text
         and the hover highlight stops mid-menu. Same reason ItemMenuPanel wraps
         its rows in a flex `<li>`. -->
    <div class="flex flex-col border-t border-ink/10 p-1">
      {#if item.licenseUrl}
        <RowButton
          class="gap-2 text-[.75rem]"
          onclick={() => engine.openExternalUrl(item.licenseUrl)}
        >
          Read the licence
          <ArrowSquareOutIcon size={18} class="ml-auto opacity-55" aria-hidden="true" />
        </RowButton>
      {/if}
      {#if item.projectUrl}
        <RowButton
          class="gap-2 text-[.75rem]"
          onclick={() => engine.openExternalUrl(item.projectUrl)}
        >
          Project page
          <ArrowSquareOutIcon size={18} class="ml-auto opacity-55" aria-hidden="true" />
        </RowButton>
      {/if}
      {#if item.installed}
        {@const inUse = modulesUsing(item.id)}
        {#if confirmingRemoveId === item.id}
          <!-- The one case worth a second click. Removing a plugin that is
               currently in the chain does not stop the sound — the plugin is
               already loaded, and it plays until the rig is next opened — so
               what the user is really deciding is the state of every rig that
               names it. Said plainly, with the count, because "are you sure" on
               its own tells nobody anything. -->
          <div class="px-2 py-1.5 text-[.7rem] leading-snug text-muted">
            {inUse}
            {inUse === 1 ? 'module in your rack uses' : 'modules in your rack use'}
            {item.name}. It keeps playing until you load a rig again, and then comes back as a
            missing module.
          </div>
          <RowButton class="gap-2 text-[.75rem] text-warn" onclick={() => remove(item.id)}>
            <TrashIcon size={13} aria-hidden="true" />
            Remove anyway
          </RowButton>
          <RowButton class="gap-2 text-[.75rem]" onclick={() => (confirmingRemoveId = null)}>
            Keep it
          </RowButton>
        {:else}
          <!-- Removes on the click, with no second prompt: it is reversible from
               the row it was clicked on — the package goes straight back to
               offering Install. A plugin that is in the rack right now is the
               exception, and asks above. -->
          <RowButton class="gap-2 text-[.75rem] text-warn" onclick={() => remove(item.id)}>
            <TrashIcon size={13} aria-hidden="true" />
            Remove
          </RowButton>
        {/if}
      {/if}
    </div>
  </Popover>
{/snippet}

<!-- One section and everything filed under it. Entries at this exact level come
     before the subsections: a package categorised "Effects" alongside an
     "Effects > Reverb" is the general case — a rack that spans all of them —
     and putting it after the specific ones would read as an afterthought.

     Recursive, because how deep the tree goes is the catalogue's decision and
     the panel has no say in it: a subsection is a longer path in the JSON, not
     a change here. -->
{#snippet packageSection(node: CategoryNode<CataloguePackage>, depth: number)}
  {#if depth > 0}
    {@render subsectionHeader(node.category, depth)}
  {/if}
  {#each node.entries as item (item.id)}
    {@render packageRow(item)}
  {/each}
  <!-- Keyed on the heading alone, which is unique among siblings — two nodes
       with the same name only ever sit under different parents. -->
  {#each node.children as child (child.category)}
    {@render packageSection(child, depth + 1)}
  {/each}
{/snippet}

{#snippet linkRow(link: CatalogueLink)}
  <RowButton layout="stack" class="rounded-none" onclick={() => engine.openExternalUrl(link.url)}>
    <span class="flex w-full min-w-0 items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-[.8rem] font-medium text-ink">{link.label}</span>
      <ArrowSquareOutIcon size={18} class="flex-none opacity-55" aria-hidden="true" />
    </span>
    {#if link.note}
      <span class="w-full truncate text-[.7rem] text-muted">{link.note}</span>
    {/if}
  </RowButton>
{/snippet}

<!-- The same shape for links, because a link's category is the same field
     answering the same question — see `groupByCategory`, which both lists go
     through. -->
{#snippet linkSection(node: CategoryNode<CatalogueLink>, depth: number)}
  {#if depth > 0}
    {@render subsectionHeader(node.category, depth)}
  {/if}
  {#each node.entries as link (link.url)}
    {@render linkRow(link)}
  {/each}
  {#each node.children as child (child.category)}
    {@render linkSection(child, depth + 1)}
  {/each}
{/snippet}

<div class="flex flex-col gap-2 px-[.6rem] pt-2 pb-[.6rem]">
  <!-- Bundles first: a bundle is what someone with an empty rack actually wants,
       and the individual plugins below are for everyone else. -->
  {#each catalogue.bundles as bundle (bundle.id)}
    {@const pending = bundlePendingIds(bundle, catalogue, run)}
    <!-- Tinted and edged in the accent, unlike every other card in the panel: a
         bundle is an offer, not a section of the list, and on a plain card it
         read as one more category whose heading happened to be sentence case.
         Same treatment the accent Install button below it carries, so the card
         and its one action read as the same proposition. -->
    <Card class="border-accent/25 bg-accent/5">
      <div class="flex flex-col gap-[.15rem] px-[.6rem] pt-[.45rem] pb-[.4rem]">
        <!-- The name in the accent, and no eyebrow above it: "Starter bundle"
             already says what kind of thing this is, so a "BUNDLE" label over
             it only said it twice. The accent is what still sets the card apart
             from the category headings below. -->
        <h2 class="text-sm font-semibold text-accent">{bundle.name}</h2>
        {#if bundle.description}
          <p class="text-xs leading-5 text-muted">{bundle.description}</p>
        {/if}
      </div>
      <!-- What is in it, folded away. Names and nothing else when opened:
           every one of them is a row further down with its own size, licence
           and action, so spelling any of that out here would make the bundle card
           a second copy of the list rather than a summary of it. Folded because
           the bundle's promise is the description above — the contents are what
           you check before committing, not what you read first. -->
      {@const contents = bundleEntries(bundle)}
      {@const open = openBundles[bundle.id] === true}
      <div class="px-[.6rem] pb-2">
        <!-- One line for both questions the card raises: what is in here, and
             have I got it. They were a disclosure and a separate "All 6
             installed" tick, which is two controls saying one thing — and a
             bundle that is fully installed has no button under it, so the state
             has nowhere else to live. -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-[.3rem] border-0 bg-transparent p-0 text-left text-[.7rem] text-muted hover:text-ink focus-visible:[outline:var(--focus-ring)] focus-visible:outline-offset-(--focus-out)"
          aria-expanded={open}
          aria-controls="bundle-contents-{bundle.id}"
          onclick={() => (openBundles = { ...openBundles, [bundle.id]: !open })}
        >
          <CaretRightIcon
            size={11}
            class={['flex-none transition-transform', open && 'rotate-90']}
            aria-hidden="true"
          />
          {contents.length}
          {contents.length === 1 ? 'package' : 'packages'}
          {#if pending.length === 0}
            <span class="ml-auto">
              {contents.some((entry) => entry.state === 'unavailable')
                ? 'Nothing more for this OS'
                : 'All installed'}
            </span>
          {/if}
        </button>
        <!-- One word per member for where it stands. Words rather than
             coloured dots: three states need three legends, and a name with
             "Outdated" beside it needs no key. Only the outdated one takes
             colour, tying it to the Update button below. -->
        {#if open}
          <ul
            id="bundle-contents-{bundle.id}"
            class="m-0 flex list-none flex-col gap-[.1rem] p-0 pt-[.3rem] pl-[1.1rem]"
            transition:slide={reveal.slide()}
          >
            {#each contents as entry (entry.id)}
              <li class="flex items-center gap-2 text-[.7rem]">
                <span class="min-w-0 flex-1 truncate text-muted">{entry.name}</span>
                <span
                  class={[
                    'shrink-0 text-[.625rem]',
                    entry.state === 'outdated' ? 'text-accent' : 'text-muted/60',
                  ]}
                >
                  {entry.state === 'missing'
                    ? 'Missing'
                    : entry.state === 'outdated'
                      ? 'Outdated'
                      : entry.state === 'unavailable'
                        ? 'Not on this OS'
                        : 'Up to date'}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      {#if pending.length > 0}
        <div class="px-[.6rem] pb-2">
          <Button
            tone="accent"
            block
            disabled={catalogue.busy}
            onclick={() => install(pending, bundle.id)}
          >
            {bundleLabel(bundle)}
          </Button>
        </div>
      {/if}
    </Card>
  {/each}

  <!-- One card per catalogue category — "Amps", "Cabs & IRs", "Effects" — not
       one for plugins and one for content. How a package is packaged is the
       installer's business; what a guitarist came looking for is the panel's,
       and an IR bundle belongs beside the loader that plays it rather than in a
       section named after its file format. -->
  {@render catalogueBar()}

  {#each packageGroups as group (group.category)}
    <Card>
      {@render cardHeader(group.category)}
      {@render packageSection(group, 0)}
    </Card>
  {:else}
    <!-- Nothing to group. The bar above still carries Refresh, which is the one
         control that can do anything about it. -->
    <Card>
      <p class="px-[.6rem] py-[.45rem] text-[.7rem] leading-[1.35] text-warn">
        {catalogue.error || 'No plugin catalogue available.'}
      </p>
    </Card>
  {/each}

  <!-- Where to get what Plectrify does not host. It ships no amp captures (the
       catalogue's own comment records why), and in time this is where plugins
       we cannot redistribute will point too — so the sections are named by the
       catalogue's own categories rather than by a heading here that would have
       to be rewritten every time the mix of downloads changes. -->
  {#each linkGroups as group (group.category)}
    <Card>
      {@render cardHeader(group.category)}
      {@render linkSection(group, 0)}
    </Card>
  {/each}

  <!-- Licence disclosure comes from the catalogue, not from a file in the
       installer: change the offered plugins and their notices change with them,
       instead of a stale document on disk describing plugins that are no longer
       on offer. Folded, because it is reference material read once — the
       summary line keeps it one click from anywhere in the panel. -->
  {#if noticeParagraphs.length > 0 || catalogue.dir}
    <details class="group px-[.6rem]">
      <summary
        class="flex cursor-pointer list-none items-center gap-[.3rem] text-[.7rem] text-muted marker:hidden hover:text-ink focus-visible:[outline:var(--focus-ring)] focus-visible:outline-offset-(--focus-out)"
      >
        <CaretRightIcon
          size={11}
          class="flex-none transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Licences and downloads
      </summary>
      <div class="flex flex-col gap-1.5 pt-[.4rem] pl-[1.1rem] text-[.68rem] leading-relaxed">
        {#each noticeParagraphs as paragraph (paragraph)}
          <p class="m-0 text-muted">{paragraph}</p>
        {/each}
        {#if catalogue.dir}
          <p class="m-0 truncate text-muted/70" title={catalogue.dir}>
            Installs to {catalogue.dir}
          </p>
        {/if}
      </div>
    </details>
  {/if}
</div>
