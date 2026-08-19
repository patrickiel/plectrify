/**
 * Plugin catalogue: the downloadable plugin packages offered in the Packages panel.
 *
 * The catalogue lives on the server (Debug builds read the repo's
 * packaging/catalogue.json instead), so a plugin's new release reaches users
 * without a Plectrify update — a package whose published version differs from the
 * installed one simply offers an update.
 *
 * This module is pure: state plus a reducer over the native progress stream, so
 * ordering, per-row independence and partial failure are covered by unit tests
 * without a browser or a native build.
 */

/** Where the catalogue came from. Anything but `remote` (or `devLocal` while
 *  developing) means the list may be behind what the server publishes, and the
 *  panel says so rather than presenting a stale catalogue as current. */
export type CatalogueSource = 'none' | 'devLocal' | 'remote' | 'cache';

/** Per-package progress, mirroring CatalogueInstaller::Stage. `missing` and
 *  `queued` are UI-side: the native side only reports work it has started. */
export type InstallStage =
  | 'missing'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'installed'
  | 'skipped'
  | 'failed';

/** What a package is, which decided how the native side installed it: a
 *  `plugin` was unzipped into the VST3 load path and will be executed in this
 *  process; `content` unpacked into a plain data folder and is never loaded as
 *  code.
 *
 *  Carried for completeness and for tests — the panel deliberately does not
 *  branch on it. Grouping and headings come from `category`, so that no amount
 *  of UI work can change what a payload is. */
export type PackageKind = 'plugin' | 'content';

/** One catalogue entry joined with what is on disk. Mirrors the `items` array
 *  of the native `catalogueState` event — one list, plugins and content
 *  alike, in the catalogue's own order. */
export interface CataloguePackage {
  id: string;
  kind: PackageKind;
  /** Where the panel files this package, outermost heading first: `['Effects']`
   *  is one section, `['Effects', 'Reverb']` a subsection inside it. Every
   *  segment is printed verbatim, and an empty path means uncategorised — see
   *  `groupByCategory`.
   *
   *  A path rather than a single heading because one flat list of headings can
   *  only be subdivided by inventing longer names for them ("Effects", then
   *  "Effects — reverb"), which puts the nesting in the text where nothing can
   *  read it. It stays as cosmetic as it ever was: nesting is display, not
   *  trust, and `kind` still decides everything about the payload. */
  category: string[];
  /** Cross-cutting labels the panel offers as filter chips — what a package
   *  *is*, as against the one place it is filed.
   *
   *  A second cosmetic field rather than more `category`, because they answer
   *  different questions and a package has one answer to the first and several
   *  to the second: a multi-effect rack is a distortion and a delay and a
   *  reverb, and it sits in exactly one section. Chips were built from the
   *  top-level heading until that showed its limit — with everything on offer
   *  filed under "Effects", the row read "Effects 22" and narrowed nothing.
   *
   *  Empty is a legitimate answer, not an oversight: an entry with no tag
   *  simply appears under no chip. Cosmetic at the same depth `category` is —
   *  `kind` still decides everything about the payload. */
  tags: string[];
  name: string;
  purpose: string;
  version: string;
  licenseId: string;
  licenseUrl: string;
  projectUrl: string;
  downloadBytes: number;
  /** True when Plectrify serves the payload THIS computer would download, rather
   *  than pointing at the project's own release. Only where upstream ships this
   *  platform in a form we cannot unzip, or ships it nothing at all — which is
   *  per platform, so a package can be hosted here and mirrored elsewhere. */
  selfHosted: boolean;
  installed: boolean;
  installedVersion: string;
  updateAvailable: boolean;
  /** Whether this build's platform gets a payload at all. The engine answers
   *  (it selects the platform asset natively), so the page never learns
   *  platform slugs — false just renders the row greyed with install disabled,
   *  keeping the catalogue honest instead of quietly thinner per OS. Absent in
   *  the event (an older engine) means available. */
  available: boolean;
  /** Installed, but no longer in the catalogue. It keeps working; it just stops
   *  being offered. Shown rather than hidden, so a plugin the user did not
   *  install by hand is always accounted for. */
  unlisted: boolean;
  /** Where a content package unpacked to. Empty for a plugin, whose directory
   *  is the managed VST3 one the panel already names once. */
  dir: string;
  /** The one package this one needs, installed ahead of it; '' for a package
   *  that stands alone. Always points from the thing that needs something to
   *  the thing it needs: a patch names the plugin it was built for, never the
   *  reverse.
   *
   *  The native side resolves this itself, so the panel needs it only to say
   *  what a click is about to fetch — installing a patch and silently pulling
   *  down a plugin as well would be the panel keeping something back. */
  dependsOn: string;
}

/** Licence disclosure carried by the catalogue, so changing the offered
 *  packages changes their notices in the same step. Rendered in the panel; the
 *  installer ships no notices file that could go stale against it. */
export interface CatalogueNotices {
  summary: string;
  fetched: string;
  hosted: string;
  models: string;
  uninstall: string;
}

export const EMPTY_CATALOGUE_NOTICES: CatalogueNotices = {
  summary: '',
  fetched: '',
  hosted: '',
  models: '',
  uninstall: '',
};

/** A named bundle of plugins. Holds only IDs plus a version of its own, so a
 *  bundle can gain or lose plugins without touching any plugin definition.
 *
 *  `version` is the bundle's, independent of its plugins': it records which
 *  edition the user installed, so a bundle that gains a plugin offers an update
 *  even when every plugin already installed is current. */
export interface CatalogueBundle {
  id: string;
  name: string;
  description: string;
  version: string;
  packageIds: string[];
  /** Named by the bundle but not installed at all. */
  missingPackageIds: string[];
  /** Installed at a different version than the catalogue publishes. */
  outdatedPackageIds: string[];
  /** The bundle version recorded when it was last fully installed, or ''. */
  installedVersion: string;
  installed: boolean;
  updateAvailable: boolean;
}

/** Where to get something Plectrify does not host — amp captures, cabinet IRs,
 *  and in time plugins we cannot redistribute. Plectrify bundles none of it:
 *  TONE3000's terms forbid mirroring their catalogue, and the one large
 *  GPL-labelled .nam collection relicenses other people's captures and names
 *  them after live trademarks. So the panel points at the source instead, and
 *  carrying the links in the catalogue means a moved link is a publish rather
 *  than an app release. */
export interface CatalogueLink {
  /** Where the panel files this link, outermost heading first — the same shape
   *  and the same rules as a package's, since both lists go through one
   *  `groupByCategory`. Empty means uncategorised. Data rather than UI so that
   *  offering a new kind of download needs no release. */
  category: string[];
  /** The same chip labels a package carries, and the reason links have them at
   *  all: a chip is a question about what you are after ("reverb", "amps"),
   *  and the honest answer often includes something Plectrify does not host.
   *  Choosing a chip used to drop the link cards whole, which quietly made
   *  "Reverb" mean "the reverbs we install". */
  tags: string[];
  label: string;
  url: string;
  note: string;
}

/** One heading and what sits under it: the entries filed at this exact level,
 *  and any deeper headings. A tree rather than a flat list because a category
 *  is a path — see `CataloguePackage.category`. */
export interface CategoryNode<T> {
  /** This level's heading alone: "Reverb", never "Effects > Reverb". */
  category: string;
  /** The whole path down to here, which is the node's identity — two different
   *  parents may each hold a "Reverb", so this and not `category` is what a
   *  rendered list should key on. */
  path: string[];
  /** Entries filed at this exact level, in the order the catalogue listed them.
   *  A node with children can still have its own: an effects rack that spans
   *  every subsection belongs to the parent and to none of them. */
  entries: T[];
  /** Deeper headings, in the order their segment was first seen. */
  children: CategoryNode<T>[];
}

/** The heading uncategorised entries gather under. They are grouped rather than
 *  hidden or shown bare: an entry with no category is an authoring oversight,
 *  and dropping it would lose the download entirely. */
export const UNCATEGORISED = 'More downloads';

/**
 * Groups packages or links into the heading tree the panel renders, preserving
 * the catalogue's order twice over at every level: headings appear in the order
 * their segment is first seen among their siblings, and entries keep their
 * order within a heading. So the panel's section order is editable from the
 * JSON alone, with no sort rule of its own to disagree with.
 *
 * A parent named only by a longer path still gets a node — a catalogue with
 * `['Effects', 'Reverb']` and nothing filed under "Effects" itself renders an
 * "Effects" section holding one subsection, rather than a bare "Reverb" at the
 * top level that says nothing about what it is a kind of.
 *
 * Uncategorised entries always end up last, whatever position they held,
 * because a fallback heading above a named one reads as the more important of
 * the two. Only the top level can hold them: an entry either has a path or has
 * none, so there is no such thing as a half-categorised one to bury deeper.
 *
 * One function for both lists, because "which heading does this go under" is
 * the same question whether the thing is downloaded or linked to — and two
 * copies of these ordering rules would eventually answer it differently.
 */
export function groupByCategory<T extends { category: readonly string[] }>(
  entries: readonly T[],
): CategoryNode<T>[] {
  const roots: CategoryNode<T>[] = [];
  // Keyed by the whole path, not by the heading: "Reverb" under "Effects" and
  // "Reverb" under some future "Amps" are two different sections.
  const byPath = new Map<string, CategoryNode<T>>();

  function nodeFor(path: string[]): CategoryNode<T> {
    // NUL joins the segments, so no heading anyone could type makes two
    // different paths share a key. Case-folded, because hand-typed headings
    // ("test / sub", "Test / Other") mean the same section whatever the
    // shift key did — the first-seen casing is the one printed.
    const key = path.map((segment) => segment.toLowerCase()).join('\u0000');
    const existing = byPath.get(key);
    if (existing !== undefined) return existing;

    const node: CategoryNode<T> = {
      category: path[path.length - 1],
      path,
      entries: [],
      children: [],
    };
    byPath.set(key, node);
    // Creating a node creates its ancestors, so a path may name a heading no
    // entry sits directly under.
    (path.length === 1 ? roots : nodeFor(path.slice(0, -1)).children).push(node);
    return node;
  }

  for (const entry of entries) {
    const path = entry.category.filter((segment) => segment.length > 0);
    nodeFor(path.length > 0 ? [...path] : [UNCATEGORISED]).entries.push(entry);
  }

  const uncategorised = roots.filter((node) => node.category === UNCATEGORISED);
  return [...roots.filter((node) => node.category !== UNCATEGORISED), ...uncategorised];
}

export interface CatalogueState {
  /** Every package the catalogue offers, plugins and content alike, in its
   *  order. They were two lists until they turned out to differ only in where
   *  the payload lands — which `kind` carries — and grouping them by `category`
   *  says far more to a guitarist than splitting them by packaging ever did. */
  items: CataloguePackage[];
  bundles: CatalogueBundle[];
  links: CatalogueLink[];
  notices: CatalogueNotices;
  busy: boolean;
  /** Where packages install to, shown so the user knows what to back up. */
  dir: string;
  source: CatalogueSource;
  /** Why the catalogue is stale or empty. Empty when all is well. */
  error: string;
}

/** A single native progress event. */
export interface InstallProgress {
  id: string;
  name: string;
  stage: InstallStage;
  index: number;
  count: number;
  received: number;
  total: number;
  error?: string;
}

export interface InstallFinished {
  ok: boolean;
  installed: string[];
  skipped: string[];
  removed: string[];
  failed: { id: string; error: string }[];
  cancelled: boolean;
  error?: string;
}

/** Live per-row progress, keyed by package id. Separate from CatalogueState
 *  because state comes from disk truth and this comes from the event stream —
 *  the two are reconciled whenever a fresh state arrives. */
export type InstallRunState = Record<
  string,
  { stage: InstallStage; received: number; total: number; error?: string }
>;

export const EMPTY_CATALOGUE_STATE: CatalogueState = {
  items: [],
  bundles: [],
  links: [],
  notices: EMPTY_CATALOGUE_NOTICES,
  busy: false,
  dir: '',
  source: 'none',
  error: '',
};

/** Stages the installer has finished with. A later duplicate or out-of-order
 *  event must not walk a row backwards out of one of these. */
const TERMINAL_STAGES: ReadonlySet<InstallStage> = new Set(['installed', 'skipped', 'failed']);

/** Folds one progress event into the run state.
 *
 * Rows are independent: an event for one package never touches another's entry,
 * so one failure cannot disturb rows still downloading. Events that arrive late
 * or duplicated are ignored once a row has reached a terminal stage, because
 * the bridge does not guarantee delivery order and a stale `downloading` after
 * `failed` would show a row as busy forever.
 */
export function reduceInstallProgress(
  state: InstallRunState,
  event: InstallProgress,
): InstallRunState {
  const existing = state[event.id];

  if (existing && TERMINAL_STAGES.has(existing.stage)) return state;

  return {
    ...state,
    [event.id]: {
      stage: event.stage,
      received: event.received,
      total: event.total,
      error: event.error || undefined,
    },
  };
}

/** Marks rows as queued the moment the user clicks, so a row does not sit on
 *  `missing` while the installer works through the packages ahead of it. */
export function queueInstallRows(state: InstallRunState, ids: string[]): InstallRunState {
  const next = { ...state };
  for (const id of ids) next[id] = { stage: 'queued', received: 0, total: 0 };
  return next;
}

/** Clears rows that finished, leaving failures visible so their Retry stays
 *  reachable. Called when a fresh `catalogueState` lands: from there on the
 *  row renders from disk truth, not from the stream. */
export function settleInstallRun(state: InstallRunState): InstallRunState {
  const next: InstallRunState = {};
  for (const [id, row] of Object.entries(state)) {
    if (row.stage === 'failed') next[id] = row;
  }
  return next;
}

/** The stage to render for a package: the live one while a run is in flight,
 *  otherwise what disk says. */
export function stageForItem(item: CataloguePackage, run: InstallRunState): InstallStage {
  const live = run[item.id];
  if (live) return live.stage;
  return item.installed ? 'installed' : 'missing';
}

/** Whether a row's action should read "Update" rather than "Install".
 *
 *  Availability counts here as much as it does on a missing row: a package
 *  installed before this build's platform stopped being offered one still shows
 *  a version difference, and offering to fetch a payload that does not exist is
 *  a button whose only outcome is a failure message. */
export function isUpdatable(item: CataloguePackage): boolean {
  return item.installed && item.updateAvailable && !item.unlisted && item.available;
}

/** Whether a row's action should read "Install" — nothing on disk, and a
 *  payload for this platform to put there. The complement of `isUpdatable`
 *  over the rows that offer a button at all. */
export function isInstallable(item: CataloguePackage): boolean {
  return !item.installed && item.available;
}

/** Which slice of the catalogue the panel is showing. `all` is the catalogue
 *  as published; the rest are the questions the status line used to state
 *  without offering any way to act on.
 *
 *  `installed` is not the complement of `installable`: a package this platform
 *  has no payload for is in neither, which is the point of having both. */
export type PackageView = 'all' | 'installable' | 'installed' | 'updatable';

/** Whether an entry answers to what was typed in the filter box. Name, purpose,
 *  headings and tags all match, because all four are on screen: someone who
 *  reads "Reverb" over five rows, or on a chip, and types it should not be told
 *  there is nothing there. Case- and edge-insensitive, and an empty query
 *  matches everything — the filter narrows, it never hides. */
function matchesQuery(
  entry: {
    name: string;
    purpose: string;
    category: readonly string[];
    tags: readonly string[];
  },
  needle: string,
): boolean {
  if (needle === '') return true;
  return [entry.name, entry.purpose, ...entry.category, ...entry.tags].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** Whether an entry carries a chip's label. Exact, and case-sensitively so: a
 *  tag is picked from a chip the catalogue itself wrote, never typed, so two
 *  spellings of one label are an authoring mistake worth seeing as two chips
 *  rather than quietly merging. */
function hasTag(entry: { tags: readonly string[] }, tag: string): boolean {
  return entry.tags.includes(tag);
}

/** The rows to render, given the chosen view and what is typed in the filter.
 *
 *  A package with no payload for this platform is dropped from `installable`
 *  rather than shown greyed: the view exists to answer "what can I add", and a
 *  row whose button is permanently absent is not an answer to it. It keeps its
 *  place under `all`, which is where the catalogue is not to look thinner per
 *  OS than it is. */
export function filterPackages(
  items: readonly CataloguePackage[],
  view: PackageView,
  query: string,
  tag = '',
): CataloguePackage[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    if (tag !== '' && !hasTag(item, tag)) return false;
    if (view === 'installable' && !isInstallable(item)) return false;
    // What is on disk, whatever the catalogue can offer this platform today:
    // an installed package keeps working after its payload stops being
    // published, and a view of "what have I got" that dropped it would be
    // answering about the catalogue rather than about the machine.
    if (view === 'installed' && !item.installed) return false;
    if (view === 'updatable' && !isUpdatable(item)) return false;
    return matchesQuery(item, needle);
  });
}

/** One chip per tag present in `entries`, with how many carry it, in the order
 *  the tag was first seen. First appearance rather than by count, for the same
 *  reason sections are: the order is then the catalogue's, editable from the
 *  JSON alone, and a chip does not move under the reader as a filter narrows.
 *
 *  Takes one flat list so packages and links can be counted together — a chip
 *  is a question about what someone is after, and hiding the links from its
 *  number would make "Reverb 6" mean "the six reverbs we install" while the
 *  card below it named three more.
 *
 *  Counted over whatever list it is handed rather than over the whole
 *  catalogue, so the panel feeds it the rows a view and a query have already
 *  left standing: a chip is then never offered for a selection that would come
 *  up empty, and its number always matches what clicking it produces. */
export function tagCounts(
  entries: readonly { tags: readonly string[] }[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    // An entry that somehow repeats a tag counts once — the normalizer drops
    // duplicates, so this only bites on a hand-built list in a test.
    for (const tag of new Set(entry.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  return [...counts].map(([tag, count]) => ({ tag, count }));
}

/** The same query, and the same chip, against the outbound links. No view:
 *  none of the narrowing views is a question a link can answer — nothing here
 *  is installed, so "what can I add" and "what is behind" both exclude the lot,
 *  and the panel drops the sections whole rather than rendering empty cards.
 *
 *  A tag is different in kind, which is why it is here and the view is not: it
 *  asks what someone is after rather than what is on their disk, and half the
 *  answer to "amps" is a link. */
export function filterLinks(
  links: readonly CatalogueLink[],
  query: string,
  tag = '',
): CatalogueLink[] {
  const needle = query.trim().toLowerCase();
  return links.filter(
    (link) =>
      (tag === '' || hasTag(link, tag)) &&
      matchesQuery({ ...link, name: link.label, purpose: link.note }, needle),
  );
}

/**
 * Expands requested ids into everything an install of them will actually cover:
 * each package's dependency chain ahead of the package that named it, every id
 * once.
 *
 * A mirror of the native `resolveInstallOrder`, which is what really decides the
 * run — this side needs the same answer only so the panel can mark every row the
 * click is about to touch, rather than leaving a dependency sitting on "missing"
 * while it downloads. Ids with no row are dropped, as the installer drops them.
 *
 * Cycle-safe: a chain stops when it revisits a package. `validate` refuses to
 * publish a catalogue containing a loop, so that is belt-and-braces rather than
 * a supported shape.
 */
export function resolveInstallIds(ids: string[], items: readonly CataloguePackage[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: string[] = [];

  for (const id of ids) {
    // Walk to the end of the chain, then add it back to front so a dependency
    // always precedes whatever named it. `chain` doubles as the loop guard.
    const chain: string[] = [];

    for (let next = id; next && !chain.includes(next);) {
      const item = byId.get(next);
      if (item === undefined) break;

      chain.push(next);
      next = item.dependsOn;
    }

    for (const entry of chain.reverse()) if (!out.includes(entry)) out.push(entry);
  }

  return out;
}

/** The name behind a package's `dependsOn`, for the row that has to say what
 *  else a click will fetch. '' when it depends on nothing; an id with no row
 *  falls back to itself, since a catalogue that inconsistent is better reported
 *  by an id than by silence. */
export function dependencyName(item: CataloguePackage, items: readonly CataloguePackage[]): string {
  if (!item.dependsOn) return '';
  return items.find((entry) => entry.id === item.dependsOn)?.name ?? item.dependsOn;
}

/** Ids the "Install all" action should act on: everything not already at the
 *  published version, updates included, minus anything already running — and
 *  minus rows this platform is not offered, which would only queue up
 *  guaranteed failures. */
export function pendingInstallIds(state: CatalogueState, run: InstallRunState): string[] {
  return state.items
    .filter((item) => !item.unlisted && item.available)
    .filter((item) => !item.installed || item.updateAvailable)
    .filter((item) => {
      const stage = run[item.id]?.stage;
      return stage === undefined || stage === 'failed';
    })
    .map((item) => item.id);
}

/** Package ids a bundle still needs: never installed, or installed at a different
 *  version than the catalogue publishes. Already-current packages are skipped,
 *  so installing a bundle never re-downloads what the user has.
 *
 *  Minus, as everywhere else, what this platform is not offered. A bundle is one
 *  list of ids with no per-platform form — deliberately, since two lists would
 *  drift and a bundle that quietly meant something different per OS would be
 *  worse than one that is visibly incomplete — so it is the panel that has to
 *  skip the ids this build cannot install rather than queue certain failures. */
export function bundlePendingIds(
  bundle: CatalogueBundle,
  state: CatalogueState,
  run: InstallRunState,
): string[] {
  const available = new Set(state.items.filter((item) => item.available).map((item) => item.id));

  return [...bundle.missingPackageIds, ...bundle.outdatedPackageIds].filter((id) => {
    if (!available.has(id)) return false;
    const stage = run[id]?.stage;
    return stage === undefined || stage === 'failed';
  });
}

/** Bytes a bundle still needs to fetch. */
export function bundlePendingBytes(
  bundle: CatalogueBundle,
  state: CatalogueState,
  run: InstallRunState,
): number {
  const pending = new Set(bundlePendingIds(bundle, state, run));
  return state.items
    .filter((item) => pending.has(item.id))
    .reduce((sum, item) => sum + item.downloadBytes, 0);
}

/** Total bytes still to fetch, for the "Install all (~X MB)" label. */
export function pendingDownloadBytes(state: CatalogueState, run: InstallRunState): number {
  const ids = new Set(pendingInstallIds(state, run));
  return state.items
    .filter((item) => ids.has(item.id))
    .reduce((sum, item) => sum + item.downloadBytes, 0);
}

// --- Normalizers -----------------------------------------------------------
// Events cross the bridge as untyped JSON. These coerce them to the shapes
// above, discarding anything malformed rather than letting a missing field
// surface as `undefined` in the panel.

const STAGES: ReadonlySet<string> = new Set([
  'missing',
  'queued',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'installed',
  'skipped',
  'failed',
]);

const SOURCES: ReadonlySet<string> = new Set(['none', 'devLocal', 'remote', 'cache']);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A category path off the wire. A bare string is read as a one-segment path,
 *  because the catalogue's own authoring format lets a single heading go
 *  without brackets and this normalizer must not be stricter than the format it
 *  mirrors. Blank segments are dropped rather than rendered as an unnamed
 *  subsection between two named ones. */
function categoryPath(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : strings(value);
  return raw.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** A tag list off the wire. Read like a category path — a bare string is one
 *  tag — and additionally deduplicated, since a tag is a set membership rather
 *  than a position and a repeat would otherwise count a row twice under its own
 *  chip. Absent means no tags, which is a legitimate answer. */
function tagList(value: unknown): string[] {
  return [...new Set(categoryPath(value))];
}

export function normalizeCatalogueState(data: unknown): CatalogueState {
  const raw = (data ?? {}) as Record<string, unknown>;
  const source = str(raw.source);

  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const id = str(item.id);
      if (!id) return null;

      return {
        id,
        // Anything that is not exactly 'content' is treated as a plugin, which
        // is only safe because nothing on this side of the bridge acts on it —
        // where the payload landed was decided natively, long before this.
        kind: str(item.kind) === 'content' ? 'content' : 'plugin',
        category: categoryPath(item.category),
        tags: tagList(item.tags),
        name: str(item.name) || id,
        purpose: str(item.purpose),
        version: str(item.version),
        licenseId: str(item.licenseId),
        licenseUrl: str(item.licenseUrl),
        projectUrl: str(item.projectUrl),
        downloadBytes: num(item.downloadBytes),
        selfHosted: item.selfHosted === true,
        installed: item.installed === true,
        installedVersion: str(item.installedVersion),
        updateAvailable: item.updateAvailable === true,
        available: item.available !== false,
        unlisted: item.unlisted === true,
        dir: str(item.dir),
        dependsOn: str(item.dependsOn),
      } satisfies CataloguePackage;
    })
    .filter((item): item is CataloguePackage => item !== null);

  const rawNotices = (raw.notices ?? {}) as Record<string, unknown>;

  const bundles = (Array.isArray(raw.bundles) ? raw.bundles : [])
    .map((entry) => {
      const bundle = (entry ?? {}) as Record<string, unknown>;
      const id = str(bundle.id);
      if (!id) return null;

      return {
        id,
        name: str(bundle.name) || id,
        description: str(bundle.description),
        version: str(bundle.version),
        packageIds: strings(bundle.packageIds),
        missingPackageIds: strings(bundle.missingPackageIds),
        outdatedPackageIds: strings(bundle.outdatedPackageIds),
        installedVersion: str(bundle.installedVersion),
        installed: bundle.installed === true,
        updateAvailable: bundle.updateAvailable === true,
      } satisfies CatalogueBundle;
    })
    .filter((bundle): bundle is CatalogueBundle => bundle !== null);

  const links = (Array.isArray(raw.links) ? raw.links : [])
    .map((entry) => {
      const link = (entry ?? {}) as Record<string, unknown>;
      const label = str(link.label);
      const url = str(link.url);
      // https only: these go to the user's browser and arrive over the network.
      return label && url.startsWith('https://')
        ? ({
            category: categoryPath(link.category),
            tags: tagList(link.tags),
            label,
            url,
            note: str(link.note),
          } satisfies CatalogueLink)
        : null;
    })
    .filter((link): link is CatalogueLink => link !== null);

  return {
    items,
    bundles,
    links,
    notices: {
      summary: str(rawNotices.summary),
      fetched: str(rawNotices.fetched),
      hosted: str(rawNotices.hosted),
      models: str(rawNotices.models),
      uninstall: str(rawNotices.uninstall),
    },
    busy: raw.busy === true,
    dir: str(raw.dir),
    source: SOURCES.has(source) ? (source as CatalogueSource) : 'none',
    error: str(raw.error),
  };
}

/** Returns null for an event with no id or an unrecognised stage — a row keyed
 *  on an empty id would collide with every other malformed event. */
export function normalizeInstallProgress(data: unknown): InstallProgress | null {
  const raw = (data ?? {}) as Record<string, unknown>;
  const id = str(raw.id);
  const stage = str(raw.stage);

  if (!id || !STAGES.has(stage)) return null;

  return {
    id,
    name: str(raw.name) || id,
    stage: stage as InstallStage,
    index: num(raw.index),
    count: num(raw.count),
    received: num(raw.received),
    total: num(raw.total),
    error: str(raw.error) || undefined,
  };
}

export function normalizeInstallFinished(data: unknown): InstallFinished {
  const raw = (data ?? {}) as Record<string, unknown>;

  const failed = (Array.isArray(raw.failed) ? raw.failed : [])
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const id = str(item.id);
      return id ? { id, error: str(item.error) } : null;
    })
    .filter((entry): entry is { id: string; error: string } => entry !== null);

  return {
    ok: raw.ok === true,
    installed: strings(raw.installed),
    skipped: strings(raw.skipped),
    removed: strings(raw.removed),
    failed,
    cancelled: raw.cancelled === true,
    error: str(raw.error) || undefined,
  };
}

/** Human-readable reason for a failed row. The native side sends short tokens
 *  so the wording lives here, next to the rest of the panel's copy. */
export function describeInstallError(error: string | undefined): string {
  switch (error) {
    case 'network':
      return "Couldn't reach the download. Check your connection and try again.";
    case 'checksum':
      return "The download didn't match its expected contents, so it wasn't installed.";
    case 'locked':
      return 'The plugin is in use. Close and reopen Plectrify, then try again.';
    case 'cancelled':
      return 'Cancelled.';
    case 'busy':
      return 'Another install is already running.';
    case 'another copy is already installed':
      return 'A plugin of that name is already installed, and Plectrify did not put it there. Remove it yourself if you want Plectrify to manage it.';
    case 'the install record is damaged':
      return 'The record of what was installed is unreadable, so nothing was deleted. Remove the folder by hand if you want it gone.';
    default:
      return error || 'Something went wrong.';
  }
}
