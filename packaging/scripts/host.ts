/**
 * Build, upload and re-pin every content pack Plectrify's own author made.
 *
 *   pnpm --dir packaging host
 *   pnpm --dir packaging host -- --id amalgam-jtm45
 *   pnpm --dir packaging host -- --dry-run
 *
 * ONE SCRIPT FOR ALL OF THEM. A package is a folder of files in
 * `packaging/content/<id>/` plus the catalogue entry with the same id, and that
 * entry already says everything that used to be a per-type script: `include`
 * names the files that ship, `installDir` says what kind of content it is, and
 * `licenseId` says under what terms. So there is nothing left for a
 * host-patches and a host-captures to disagree about, and adding a third kind
 * of authored content needs a catalogue entry, not a new script.
 *
 * A folder with a `patch.json` at its top level IS a patch, and ships wrapped
 * in a folder named for the package id, because every patch installs into the
 * one shared `patches/` directory. Its `assets/` travel with it: a plugin bakes
 * the absolute path of whatever it loaded into its own opaque state, so the only
 * way a patch can be self-contained is for that path to be the same on every
 * machine — which is what installing to a fixed machine-wide folder gives
 * (ProgramData on Windows, /Users/Shared/Plectrify on macOS).
 *
 * TWO SHAPES OF SOURCE FOLDER, and which one a pack uses is decided by whether
 * its payload depends on where it is installed:
 *
 *   content/<id>/                one archive, served to every platform
 *   content/<id>.<platform>/     one archive per platform
 *
 * A patch must be the second. The baked path differs between the two content
 * roots, so a patch authored on Windows cannot work on a Mac and vice versa:
 * `content/<id>.windows-x64/` and `content/<id>.macos-arm64/` are separate
 * authorings of the same patch, each built into its own `assets` entry, and a
 * platform with no folder is simply not offered the pack. Neither is the
 * "real" one — this script has no primary platform and no fallback between
 * them, because a patch built for the wrong root is not a degraded pack, it is
 * a broken one.
 *
 * Content that bakes no paths (loose captures, IRs) is the first shape: one
 * archive, uploaded once, with every platform's `assets` entry pointing at that
 * same object. A per-platform folder may still be added beside it, and
 * overrides the neutral archive for that platform alone.
 *
 * WHAT THIS IS NOT FOR. Anything with an upstream. `host-content` mirrors a
 * third party's freely-licensed files and `host-plugin` re-hosts a binary
 * somebody else compiled; both pin and re-verify a URL, and both answer a
 * licensing question this does not have to. Here the author is us, and that is
 * the whole rule: AUTHOR is a constant rather than a flag, checked against
 * every capture's `modeled_by`, because TONE3000's terms forbid redistributing
 * tones obtained there and the large GPL-labelled .nam collection relicenses
 * other people's captures wholesale. A capture some other name trained is not
 * ours to publish under any spelling of the flag, so there is nothing for one
 * to say — `--author` only ever had one right answer, and a value that must
 * never vary is not an argument. Renaming the author is editing this constant,
 * which is also the review that deserves.
 *
 * IT IS SAFE TO RUN ANY TIME. The archive is reproducible (see pack.ts), so a
 * pack whose files have not changed hashes to what the catalogue already pins
 * and is skipped: no upload, no version bump, no write. Only what actually
 * changed moves, and when it does, the `version` and every platform's whole
 * asset — url, sha256, downloadBytes — are written together. Hand-pasting
 * those, one platform at a time, is the mistake this replaces.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { contentDir, scriptArgs } from './cli.ts';
import { ASSET_PLATFORMS } from './manifest.ts';
import { assetLocation, buildArchive, fail, upload, type PackResult } from './pack.ts';

const SCRIPT = 'host';

/** Ids that may become a file name on the way in or out. A patch's file name
 *  is its id once installed, so a name that could not survive the round trip
 *  is a broken pack, not a user's problem. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const PACKAGING_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = join(PACKAGING_DIR, 'catalogue.json');
const CONTENT_ROOT = join(PACKAGING_DIR, 'content');

/** The generated file, never a source: it is written into the staging folder
 *  after the sources are copied there. */
const PROVENANCE = 'PROVENANCE.txt';

/** One patch's document. A content folder holding one of these at its top
 *  level is itself a patch, rather than a pack containing some. */
const PATCH_DOC = 'patch.json';

/** Who made everything this script publishes. Recorded in every
 *  PROVENANCE.txt, and the name each capture's own `modeled_by` must carry —
 *  see the header for why that is a constant and not a flag. */
const AUTHOR = 'Plectrify';

/** What a never-published package pins until its first upload. `validate`
 *  requires a 64-character hex sha256, so a new entry cannot simply leave it
 *  out; zeroes are the one value that says "nothing is published here yet"
 *  without looking like a hash somebody measured. */
const UNPUBLISHED = '0'.repeat(64);

interface Entry {
  id: string;
  kind?: string;
  name?: string;
  version: string;
  licenseId?: string;
  installDir?: string;
  include?: string[];
  assets?: Record<
    string,
    { url: string; sha256: string; downloadBytes: number; selfHosted?: boolean }
  >;
}

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    /** Packs to build. Defaults to every folder under packaging/content. */
    id: { type: 'string', multiple: true, default: [] },
    /** Build and report, changing nothing anywhere. */
    'dry-run': { type: 'boolean', default: false },
    /** Override the automatic bump. Only needed for a version that is not a
     *  plain integer. */
    version: { type: 'string' },
    bucket: { type: 'string', default: 'plectrify' },
    prefix: { type: 'string', default: 'plugins/v1/content' },
  },
});


const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as { packages: Entry[] };

/** The package id a source folder belongs to: `<id>` for a neutral pack,
    `<id>` again for any `<id>.<platform>` folder. A pack may have either shape
    or both, and a per-platform-only pack (every patch) has no `<id>` folder at
    all — so ids come from stripping the suffix rather than from listing plain
    directories, which would miss those entirely. */
function packageIdOf(folder: string): string {
  const platform = ASSET_PLATFORMS.find((slug) => folder.endsWith(`.${slug}`));
  return platform ? folder.slice(0, -(platform.length + 1)) : folder;
}

const ids =
  values.id.length > 0
    ? values.id
    : [
        ...new Set(
          readdirSync(CONTENT_ROOT, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => packageIdOf(e.name)),
        ),
      ].sort();
if (ids.length === 0) fail(SCRIPT, `no packs to build: ${CONTENT_ROOT} has no package folders.`);

let changed = 0;

for (const id of ids) {
  const dir = contentDir(id);
  const platformDirs = ASSET_PLATFORMS.filter((slug) => existsSync(`${dir}.${slug}`));
  if (!existsSync(dir) && platformDirs.length === 0) {
    fail(SCRIPT, `no content folder at ${dir}, and none at ${dir}.<platform> either.`);
  }

  const entry = catalogue.packages.find((p) => p.id === id);
  if (!entry) {
    fail(SCRIPT, `no catalogue entry for "${id}". Add one to catalogue.json first.`);
  }
  // A payload built from repo files is never code. Refusing here rather than
  // relying on the entry being right keeps this script from ever being the
  // thing that puts an unreviewed binary into the VST3 load path.
  if (entry.kind !== 'content') fail(SCRIPT, `${id} is kind '${entry.kind}', not 'content'.`);
  // Every platform, not just some: this script builds a pack out of repo files
  // and serves it, so an asset here pointing anywhere but our own bucket would
  // mean the entry is mirroring somebody else's copy of it.
  const mirrored = Object.entries(entry.assets ?? {})
    .filter(([, asset]) => !asset.selfHosted)
    .map(([slug]) => slug);
  if (mirrored.length > 0) {
    fail(SCRIPT, `${id} does not mark its ${mirrored.join(', ')} asset selfHosted, so it has an upstream to mirror.`);
  }
  if (!entry.include?.length) fail(SCRIPT, `${id} declares no include patterns.`);

  const work = join(tmpdir(), `plectrify-host-${id}`);
  rmSync(work, { recursive: true, force: true });

  // The OS-neutral archive, if this pack has one, plus a per-platform archive
  // for every `<id>.<platform>` folder beside it. A patch may only be the
  // second: its plugin state bakes the install root's absolute path, so the
  // same bytes cannot serve both roots, and serving them anyway would install
  // a patch pointing at a folder that does not exist.
  const neutral = existsSync(dir) ? buildPack(entry, id, dir, join(work, 'neutral')) : undefined;
  if (neutral && existsSync(join(dir, PATCH_DOC))) {
    fail(
      SCRIPT,
      `${dir} holds a patch, which cannot be OS-neutral: a patch bakes its install root's ` +
        'absolute path into the plugin state. Author it per platform instead, in ' +
        `${ASSET_PLATFORMS.map((slug) => `${id}.${slug}`).join(' / ')}.`,
    );
  }

  const packs: Record<string, PackResult> = {};
  for (const platform of ASSET_PLATFORMS) {
    const variantDir = `${dir}.${platform}`;
    if (existsSync(variantDir)) packs[platform] = buildPack(entry, id, variantDir, join(work, platform));
    else if (neutral) packs[platform] = neutral; // OS-neutral: same bytes, same pin
  }
  if (Object.keys(packs).length === 0) {
    fail(SCRIPT, `${id} builds no payload for any platform, so there is nothing to offer.`);
  }

  // Unchanged means every payload hashes to what the catalogue already pins —
  // and no platform gained or lost one.
  const declaredPlatforms = Object.keys(entry.assets ?? {}).sort();
  const builtPlatforms = Object.keys(packs).sort();
  const unchanged =
    declaredPlatforms.join() === builtPlatforms.join() &&
    builtPlatforms.every((platform) => packs[platform]!.sha256 === entry.assets?.[platform]?.sha256);

  if (unchanged) {
    console.log(`  ${id}: unchanged (v${entry.version})`);
    continue;
  }

  // One version for every platform's payload of a package (the schema's rule),
  // so a change to any variant bumps it and republishes each payload under the
  // new version's key. Re-uploading an unchanged variant under the new key is
  // a few hundred KB of copying; two version fields would be a schema change.
  const version = values.version ?? bump(entry);

  if (values['dry-run']) {
    console.log(`  ${id}: changed -> would publish v${version}`);
    for (const platform of builtPlatforms) {
      const pack = packs[platform]!;
      const shared = pack === neutral ? ' (the OS-neutral archive)' : '';
      console.log(`      ${platform}: ${pack.downloadBytes} bytes, ${pack.sha256}${shared}`);
    }
    continue;
  }

  // The neutral archive is uploaded once under the plain key and pointed at by
  // every platform that uses it; a per-platform archive gets a key of its own.
  // No platform's key is the unsuffixed one by privilege — it is unsuffixed
  // because it is the object they share.
  const usesNeutral = builtPlatforms.some((platform) => packs[platform] === neutral);
  const neutralLocation = usesNeutral ? assetLocation(values.prefix, id, version) : undefined;
  if (neutral && neutralLocation) upload(SCRIPT, values.bucket, neutral.archivePath, neutralLocation.key);

  const assets: NonNullable<Entry['assets']> = {};
  for (const platform of builtPlatforms) {
    const pack = packs[platform]!;
    let url = neutralLocation?.assetUrl;
    if (pack !== neutral) {
      const location = assetLocation(values.prefix, id, `${version}-${platform}`);
      upload(SCRIPT, values.bucket, pack.archivePath, location.key);
      url = location.assetUrl;
    }
    // selfHosted is written with the rest of the asset rather than carried
    // over from the old one: this script is what serves these bytes, so the
    // flag is a fact it knows first-hand, and every asset it writes has it.
    assets[platform] = {
      url: url!,
      sha256: pack.sha256,
      downloadBytes: pack.downloadBytes,
      selfHosted: true,
    };
  }

  entry.version = version;
  entry.assets = assets;

  changed++;
  console.log(`  ${id}: published v${version} (${builtPlatforms.join(', ')})`);
}

/** Stage one source folder per the entry's include patterns, write its
    provenance, and archive it reproducibly. One function for the OS-neutral
    folder and every per-platform one, so two packs of the same package can
    only differ in their files — never in how they were built. */
function buildPack(entry: Entry, id: string, sourceDir: string, work: string): PackResult {
  const staged = join(work, 'staged');
  mkdirSync(staged, { recursive: true });

  // A package that IS a patch installs as one folder, named by the package id
  // — every patch shares the one patches folder, so the id is what keeps two
  // of them apart, and it is already unique across the catalogue. Anything else
  // (a pack of captures, a pack of several patches) ships its own shape.
  const wrap = existsSync(join(sourceDir, PATCH_DOC)) ? `${id}/` : '';
  if (wrap && !SAFE_ID.test(id)) {
    fail(SCRIPT, `"${id}" is a patch, so its id becomes a folder name: use letters, digits, dashes and underscores.`);
  }

  // Filtered on the path the archive will carry, which is the path the
  // installer matches against — so `include` means one thing, not two.
  const sources = collect(sourceDir)
    .map((rel) => ({ from: rel, to: `${wrap}${rel}` }))
    .filter(({ to }) => to !== PROVENANCE && matchesInclude(to, entry.include!, id))
    .sort((a, b) => a.to.localeCompare(b.to));
  if (sources.length === 0) {
    fail(SCRIPT, `nothing in ${sourceDir} matches ${id}'s include patterns (${entry.include!.join(', ')}).`);
  }

  for (const { from, to } of sources) {
    const target = join(staged, to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceDir, from), target);
    console.log(`    staged ${to}`);
  }

  const lines = [...header(entry), ''];
  // Provenance is written per top-level entry, which is the unit a user sees
  // installed: one patch folder, or one loose capture.
  const stagedPaths = sources.map(({ to }) => to);
  for (const top of [...new Set(stagedPaths.map((rel) => rel.split('/')[0]!))].sort())
    lines.push(...describe(staged, top, stagedPaths), '');
  writeFileSync(join(staged, PROVENANCE), lines.join('\n'), 'utf8');

  return buildArchive({ script: SCRIPT, staged, work });
}

if (changed === 0) {
  console.log(`\nNothing to publish.${values['dry-run'] ? ' (dry run)' : ''}`);
  process.exit(0);
}

// Written whole from the parsed document: it round-trips byte-identically at
// this indent, so the diff is the version and the assets that moved, nothing else.
writeFileSync(CATALOGUE, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
console.log(
  `\nUpdated catalogue.json (${changed} package${changed === 1 ? '' : 's'}). Next:\n` +
    '  pnpm --dir packaging validate -- --verify-assets\n' +
    '  pnpm --dir packaging publish-catalogue',
);

/** The next version of a pack whose content has moved. A package that has
    never been published keeps the version its entry declares — a first release
    is v1, not v2. Otherwise the catalogue's version is a string and nothing
    requires it to be a number, so a version this cannot count on is refused
    rather than guessed at. */
function bump(entry: Entry): string {
  // Never published means no asset pins real bytes yet — on any platform, so
  // that a pack whose first release adds a second one still starts at v1.
  const pins = Object.values(entry.assets ?? {}).map((asset) => asset.sha256);
  if (pins.length === 0 || pins.every((pin) => !pin || pin === UNPUBLISHED)) return entry.version;

  if (!/^\d+$/.test(entry.version)) {
    fail(SCRIPT, `${entry.id} is at version "${entry.version}", which is not a plain integer. ` +
      'Pass --version <next> to say what follows it.');
  }
  return String(Number(entry.version) + 1);
}

/** Every file under `dir`, as paths relative to it with forward slashes — the
    same shape a zip entry name has, so the include patterns mean the same thing
    here as they do to the installer. */
function collect(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? collect(join(dir, e.name), `${prefix}${e.name}/`)
      : [`${prefix}${e.name}`],
  );
}

/** Whether a file ships, per the catalogue's own include patterns. Matched
    against the relative path so a nested pack works: `*` stops at a separator
    and `**` crosses them, exactly as the app's `matchesIncludePattern` does. */
function matchesInclude(path: string, patterns: string[], id: string): boolean {
  return patterns.some((pattern) => {
    if (pattern.includes('\\')) {
      fail(SCRIPT, `${id}'s include pattern "${pattern}" uses a backslash; use '/'.`);
    }
    const rx = pattern
      .split('**')
      .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${rx}$`, 'i').test(path);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** The opening of a pack's PROVENANCE.txt, in the terms that pack is actually
    about. Keyed on installDir because that is the field that already says what
    kind of content this is.

    Deliberately carries no version: this file is inside the archive, so a
    version here would change the hash that decides whether the version changes
    at all. Which edition of a pack a user has is the catalogue's answer. */
function header(entry: Entry): string[] {
  const licence = entry.licenseId ?? 'an unstated licence';
  const title = `Plectrify content pack: ${entry.name ?? entry.id}`;
  switch (entry.installDir) {
    case 'patches':
      return [
        title,
        '',
        `Knob mappings and plugin tones authored by ${AUTHOR}, released under`,
        `${licence}. One patch is one folder: which parameters to put on knobs,`,
        "the plugin's own saved state, and any assets it loads. No plugin travels",
        'with it, and nothing here is loaded as code.',
      ];
    case 'nam':
      return [
        title,
        '',
        `Neural Amp Modeler captures trained by ${AUTHOR}, who owns them and`,
        `releases them under ${licence}. Plectrify hosts them because they are the`,
        'work of the same person who publishes Plectrify - no third-party capture is',
        'redistributed here, and none ever should be.',
      ];
    default:
      return [title, '', `Authored by ${AUTHOR} and released under ${licence}.`];
  }
}

/** One installed thing's provenance block, and the gates it has to pass to be
    in the pack at all: a capture has to prove who trained it, and a patch has
    to have a name that survives becoming an installed id.

    `top` is a top-level entry of the pack — a patch's folder, or a loose file
    — and `sources` is every path in the pack, so a folder can list what it
    carries. */
function describe(dir: string, top: string, sources: string[]): string[] {
  const owned = sources.filter((rel) => rel === top || rel.startsWith(`${top}/`));
  for (const rel of owned) checkCapture(join(dir, rel), rel);

  if (owned.includes(`${top}/${PATCH_DOC}`)) {
    const assets = owned.filter((rel) => rel !== `${top}/${PATCH_DOC}`);
    return describePatch(join(dir, top, PATCH_DOC), top, assets);
  }
  // A loose file: the capture packs are still a flat folder of .nam files, and
  // nothing about them wants a folder each.
  if (top.toLowerCase().endsWith('.nam')) return describeCapture(join(dir, top), top);
  return [top];
}

interface Capture {
  metadata?: { modeled_by?: string; gear_make?: string };
  sample_rate?: number;
}

/** The check that keeps somebody else's capture out of the bucket, wherever it
    appears — loose in a capture pack or bundled inside a patch's assets. It is
    a guard rail rather than proof (metadata can be edited), but every capture
    the NAM trainer produces carries it, so a mismatch is worth stopping for. */
function checkCapture(path: string, rel: string): void {
  if (!rel.toLowerCase().endsWith('.nam')) return;
  const doc = readJson<Capture>(path, `${rel} is not readable as a .nam file (they are JSON)`);
  const modeledBy = doc.metadata?.modeled_by?.trim() ?? '';
  if (!modeledBy) {
    fail(
      SCRIPT,
      `${rel} has no modeled_by metadata. Plectrify only hosts captures whose own ` +
        'attribution identifies the author; restore it before packaging this capture.',
    );
  }
  if (modeledBy.toLowerCase() !== AUTHOR.toLowerCase()) {
    fail(
      SCRIPT,
      `${rel} records modeled_by "${modeledBy}", not "${AUTHOR}". ` +
        'Plectrify only hosts captures its own author trained; if this one is somebody ' +
        "else's, link to it instead of packaging it.",
    );
  }
}

function describeCapture(path: string, name: string): string[] {
  const doc = readJson<Capture>(path, `${name} is not readable as a .nam file (they are JSON)`);
  return [
    name,
    `  Modeled by:  ${doc.metadata?.modeled_by?.trim() || 'unrecorded'}`,
    `  Gear:        ${doc.metadata?.gear_make ?? 'unrecorded'}`,
    `  Sample rate: ${doc.sample_rate ?? 'unrecorded'}`,
  ];
}

function describePatch(path: string, id: string, assets: string[]): string[] {
  if (!SAFE_ID.test(id)) {
    fail(
      SCRIPT,
      `"${id}" cannot become an installed patch id. Rename the folder to letters, ` +
        'digits, dashes and underscores - its name is the id, and it lands in one ' +
        'folder shared with every other pack.',
    );
  }

  // Matches StoredPatch in ui/src/lib/engine/patches.ts. The tone is optional:
  // a patch whose capture failed installs as a mapping, which is valid.
  const doc = readJson<{
    name?: string;
    pluginName?: string;
    displayName?: string;
    color?: string;
    knobs?: unknown[];
    pluginVersion?: string;
    state?: string;
  }>(path, `${id}/patch.json is not readable as JSON`);
  if (!doc.name || !doc.pluginName) fail(SCRIPT, `${id}/patch.json is not a patch.`);
  if (!doc.state) console.warn(`    ${id}: no tone; installing the mapping only`);

  return [
    id,
    `  Name:   ${doc.name}`,
    `  Plugin: ${doc.pluginName}${doc.pluginVersion ? ` ${doc.pluginVersion}` : ''}`,
    // The card's look, when the patch carries one: it renames and recolours
    // the module it loads into, so it belongs in what a reader is shown.
    ...(doc.displayName || doc.color
      ? [`  Card:   ${[doc.displayName, doc.color].filter(Boolean).join(' ')}`]
      : []),
    `  Knobs:  ${Array.isArray(doc.knobs) ? doc.knobs.length : 0}`,
    `  Tone:   ${doc.state ? `${doc.state.length} bytes (base64)` : 'none (mapping only)'}`,
    // Named, not just counted: an asset is the reason a patch sounds like it
    // did, and a reader should be able to see what travelled with it.
    ...(assets.length > 0
      ? [`  Assets: ${assets.map((rel) => rel.slice(id.length + 1)).join(', ')}`]
      : []),
  ];
}

function readJson<T>(path: string, whatWentWrong: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    fail(SCRIPT, `${whatWentWrong}: ${String(error)}`);
  }
}
