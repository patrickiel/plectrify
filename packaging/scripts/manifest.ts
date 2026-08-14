/**
 * Shared validation for the plugin catalogue.
 *
 * The catalogue decides which binaries users are offered and which SHA-256
 * authorises each one to be loaded into the Plectrify process, so every entry
 * point that touches it — publishing, and the release build's pre-flight —
 * validates through this one module rather than each re-implementing the rules
 * and drifting apart.
 */
import { readFile } from 'node:fs/promises';
import { R2_PUBLIC_BASE } from './pack.ts';

/**
 * What a package *is*, which decides how it is installed and how far it is
 * trusted. Not a display concept — see `category` for that.
 *
 * `plugin` is unzipped into the VST3 load path and executed inside Plectrify's
 * process. `content` unpacks into a plain data folder and is never loaded as
 * code. Keeping this a field of its own, rather than inferring it from the
 * category or from which fields happen to be present, is what stops a renamed
 * or newly-added category in a fetched catalogue from moving a payload into
 * the load path.
 */
export type PackageKind = 'plugin' | 'content';

export const PACKAGE_KINDS: readonly PackageKind[] = ['plugin', 'content'];

/** Package and bundle ids become directory and marker-file names in the app.
 *  Keep the authoring gate in lock-step with Catalogue.cpp, including refusing
 *  the `.` and `..` segments that path joining would otherwise normalise. */
const SAFE_CATALOGUE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Platform slugs a package's `assets` map may carry, alphabetically — which is
 * also the order they are written in, so no platform reads as the default.
 *
 * Windows was that default until schemaVersion 4: it lived in flat
 * assetUrl/sha256/downloadBytes fields while `assets` held only the others, and
 * every script that touched a payload had to say "the flat fields, plus each
 * entry" — two code paths for one question. It is now an ordinary key. Must
 * match the slugs Catalogue.cpp selects by.
 */
export const ASSET_PLATFORMS = ['macos-arm64', 'windows-x64'] as const;
export type AssetPlatform = (typeof ASSET_PLATFORMS)[number];

/**
 * One platform's payload of a package: where to get it, the SHA-256 that
 * authorises it, and what to extract. Every one of these pins bytes that may
 * end up loaded as code, so they all get identical scrutiny.
 */
export interface PlatformAsset {
  url: string;
  sha256: string;
  downloadBytes: number;
  /** Archive entries to extract. Omit to inherit the package's own `include`,
   *  which is the usual case: '**\/*.vst3/**' is layout-neutral and holds on
   *  every platform. Name your own only where that platform's archive is laid
   *  out differently. */
  include?: string[];
  /**
   * Plectrify serves these bytes, rather than the user's machine fetching them
   * from the project's own release page.
   *
   * Per asset, because it is a fact about one url and nothing else — the same
   * reasoning that moved Windows's payload into `assets` in schemaVersion 4.
   * A package can perfectly well be a mirror on one platform and a re-host on
   * another (dragonfly-reverb is), and the package-level flag this replaced
   * could only answer that with a footnote.
   *
   * It is a licensing fact before it is a hosting one: Plectrify serving a
   * copyleft binary makes Plectrify its distributor, so GPL §6 attaches to us
   * and the entry must name its corresponding source. `validate` checks that,
   * and checks the flag against the url it sits on rather than taking its word
   * — which the package-level flag could not do.
   */
  selfHosted?: boolean;
}

/** Where Plectrify's own bucket serves from — the one definition, in pack.ts,
 *  which is also what the upload scripts print into a catalogue entry. A
 *  `selfHosted` asset's url is under it and a mirrored one's is not;
 *  `validate` enforces both directions. */
const HOSTED_URL_PREFIX = `${R2_PUBLIC_BASE}/`;

/**
 * One downloadable thing, plugin or not. Plugins and IR packs were two parallel
 * lists until they turned out to differ in exactly two ways — where the payload
 * lands, and whether it is code — both of which `kind` now carries. Everything
 * else about them (id, licence, hash, size, provenance) was already identical.
 */
export interface CataloguePackage {
  id: string;
  kind: PackageKind;
  /** Where the panel files this package, printed verbatim. A string is one
   *  heading; an array is a path, so ['Effects', 'Reverb'] renders "Reverb" as
   *  a subsection of "Effects".
   *
   *  Purely cosmetic at every level — nesting is display, never trust; see
   *  `PackageKind` for why this is kept well away from that decision. */
  category?: string | string[];
  name: string;
  purpose: string;
  version: string;
  licenseId: string;
  licenseUrl?: string;
  projectUrl: string;
  sourceUrl?: string;
  /**
   * Plectrify compiled this package from the project's source rather than hosting
   * a binary the project published, because it publishes none at all.
   *
   * Kept explicit rather than inferred from an asset's `selfHosted`, which is a
   * different question: that says who serves the bytes, this says who produced
   * them. It changes what "up to date" means — a source-only release is a
   * perfectly good upgrade target for a package we build ourselves, while for
   * every other entry it is unreachable — so `check-updates` reads it.
   */
  builtFromSource?: boolean;
  /** Archive entries to extract, shared by every platform. An asset may
   *  override it; most don't need to. It stays on the package because
   *  extraction patterns are usually layout-neutral, and one copy cannot drift
   *  from another. */
  include: string[];
  /** Every platform's payload, keyed by slug (see ASSET_PLATFORMS). At least
   *  one is required — a package offered nowhere is not a package. A platform
   *  with no entry is simply not offered it: that build greys the row out
   *  rather than downloading another platform's binary. */
  assets: Partial<Record<AssetPlatform, PlatformAsset>>;
  /** kind:'content' only — the plain folder name it unpacks into, under the
   *  machine-wide content root (%PROGRAMDATA%/Plectrify on Windows,
   *  /Users/Shared/Plectrify on macOS). A plugin declaring one would be asking
   *  to be installed somewhere other than the VST3 path, which is refused. */
  installDir?: string;
  /** kind:'content' only — keep the archive's folder structure instead of
   *  unpacking flat. Flat suits an IR or capture browser; a patch pack needs
   *  it, because a patch that carries its own assets is a folder. Layout only:
   *  the payload still lands under installDir and is still never code. */
  preserveStructure?: boolean;
  /**
   * The one package this one needs to be of any use, installed before it.
   *
   * The edge points from the thing that needs something to the thing it needs —
   * a patch names the plugin it was built for, never a plugin the patches that
   * happen to exist for it. Only that direction is true (a JTM45 patch is
   * worthless without Neural Amp Modeler; the plugin is fine with no patches at
   * all), and it is what lets a patch be added, revised or dropped without
   * touching the plugin's entry, its pin or its provenance.
   *
   * One id rather than a list: it answers "what is this for?", which has one
   * answer, and a package needing two unrelated things would be two packages. A
   * chain is still followed to its end.
   *
   * It must name a package in this same catalogue, may not be the package's own
   * id, and may not complete a cycle. Beyond that the edge is unrestricted —
   * content naming a plugin is the patch case exactly — because it can only
   * pull in something the catalogue already offers on a row of its own, with its
   * own kind, hash and destination.
   */
  dependsOn?: string;
  minAppVersion?: string;
}

export interface CatalogueNotices {
  summary: string;
  fetched?: string;
  hosted?: string;
  models?: string;
  uninstall?: string;
}

/** A named bundle. Holds only package IDs plus a version of its own, so a bundle
 *  can gain or lose members without touching a single package definition. Bump
 *  `version` whenever `packageIds` changes: it is how the app knows which
 *  edition a user installed. */
export interface CatalogueBundle {
  id: string;
  name: string;
  description?: string;
  version: string;
  packageIds: string[];
}

/** An outbound pointer to something Plectrify does not host — amp captures, IRs,
 *  and in time plugins whose licence or packaging rules out shipping them.
 *
 *  `category` is the panel's section path, printed verbatim and grouped by in
 *  first-appearance order — the same field, in the same two forms, as a
 *  package's. It lives here rather than in the UI so that offering a new kind
 *  of download is a catalogue publish, not a release. */
export interface CatalogueLink {
  category?: string | string[];
  label: string;
  url: string;
  note?: string;
}

export interface CatalogueManifest {
  schemaVersion: number;
  revision: number;
  notices: CatalogueNotices;
  packages: CataloguePackage[];
  bundles?: CatalogueBundle[];
  links?: CatalogueLink[];
}

/** The schema version this tooling and the shipped C++ both understand. Must
 *  match `catalogueSchemaVersion` in Source/plugins/Catalogue.h.
 *
 *  4 is the symmetric-assets format: every payload lives in `assets`, keyed by
 *  platform, with no flat Windows fields. A build older than that finds no
 *  assetUrl and rejects the catalogue outright, which is why this bump was not
 *  free — see the note in catalogue.json. */
export const SCHEMA_VERSION = 4;

export class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(message);
}

/**
 * A category as a path, whichever of the two forms it was written in.
 *
 * One reader for both, so a rule written against a path can never miss the
 * string form — and so the one place that has to know they are the same shape
 * is here rather than at each call site. Elements are returned as authored; it
 * is `validateCategory` that decides whether they are usable headings.
 */
export function categoryPath(category: string | string[] | undefined): string[] {
  if (category === undefined) return [];
  return Array.isArray(category) ? category : [category];
}

/**
 * Checks a category in either form, at every level of the path.
 *
 * One function for packages and links alike, because "is this a usable
 * heading?" is the same question for both — the same reason the app groups both
 * lists through one `groupByCategory`, and two copies would eventually answer
 * it differently.
 */
function validateCategory(where: string, category: string | string[] | undefined): void {
  if (category === undefined) return;

  // A blank category would group under the uncategorised fallback while
  // looking, in the JSON, like it had been given one. An empty array is the
  // same mistake spelled differently.
  if (Array.isArray(category) && category.length === 0) {
    fail(`${where} has an empty 'category' array; omit the field to leave it uncategorised.`);
  }

  for (const segment of categoryPath(category)) {
    // Typed as a string, but this file's whole job is to catch what a
    // hand-edited JSON actually holds.
    if (typeof segment !== 'string' || !segment.trim()) {
      fail(`${where} has an empty 'category'; omit the field to leave it uncategorised.`);
    }

    // 'Plugins' and 'Content' name the kind, not a place a guitarist would look
    // for something. Refused at every depth, since a subsection heading is read
    // exactly as literally as a top-level one.
    if (/^(plugins?|content)$/i.test(segment.trim())) {
      fail(
        `${where} has category '${segment}', which names its kind rather than what it is for. Categories are the panel's headings — use something a guitarist would look under, e.g. 'Amps', 'Cabs & IRs', 'Effects'.`,
      );
    }
  }
}

export async function readManifest(path: string): Promise<CatalogueManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(`manifest not found: ${path}`);
  }

  try {
    // Tolerate a UTF-8 BOM: some Windows editors add one, and the
    // resulting parse error names a character nobody can see.
    return JSON.parse(raw.replace(/^﻿/, '')) as CatalogueManifest;
  } catch (error) {
    fail(`manifest is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Throws on anything that would produce a broken or legally incorrect
 * catalogue. Deliberately strict: a malformed entry that reaches users is far
 * more expensive to fix than a failed publish.
 */
export function validateManifest(manifest: CatalogueManifest): void {
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `schemaVersion is ${manifest.schemaVersion}; this tooling and the shipped app understand ${SCHEMA_VERSION}. Bumping it strands every installed build, so change it only for a format change old builds genuinely cannot read.`,
    );
  }

  if (!Number.isInteger(manifest.revision) || manifest.revision < 1) {
    fail('revision must be a positive integer; it is what makes an unexpected rollback visible.');
  }

  // The notices are the app's licence disclosure — they replaced a file in the
  // installer precisely so they travel with the packages. An empty block would
  // leave users with no disclosure at all.
  if (!manifest.notices?.summary?.trim()) {
    fail(
      'notices.summary is empty. That text is the licence disclosure shown in the Packages panel; publishing without it would leave users with none.',
    );
  }

  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    fail('the manifest lists no packages.');
  }

  const seen = new Set<string>();
  const markerKeys = new Map<string, string>();

  for (const p of manifest.packages) {
    const where = p.id ? `package '${p.id}'` : 'a package';

    for (const field of ['id', 'name', 'version', 'licenseId', 'projectUrl'] as const) {
      if (!p[field]?.toString().trim()) fail(`${where} is missing '${field}'.`);
    }

    if (!SAFE_CATALOGUE_ID.test(p.id)) {
      fail(`${where} id must contain only letters, digits, dashes and underscores.`);
    }

    // Checked before anything else reads it: kind decides whether this payload
    // is unzipped into the VST3 load path, so an absent or misspelt one must
    // never fall through to a default.
    if (!PACKAGE_KINDS.includes(p.kind)) {
      fail(
        `${where} has kind '${p.kind}'; it must be one of ${PACKAGE_KINDS.map((k) => `'${k}'`).join(' or ')}. This decides whether the payload is loaded as code, so it is never inferred.`,
      );
    }

    if (seen.has(p.id)) fail(`duplicate package id '${p.id}'.`);
    seen.add(p.id);

    const markerKey = (p.kind === 'content' ? `content-${p.id}` : p.id).toLowerCase();
    const markerOwner = markerKeys.get(markerKey);
    if (markerOwner) {
      fail(`${where} shares its install marker with ${markerOwner}. Rename one of their ids.`);
    }
    markerKeys.set(markerKey, where);

    if (!p.projectUrl.startsWith('https://')) fail(`${where} projectUrl is not https.`);
    if (!Array.isArray(p.include) || p.include.length === 0) {
      fail(`${where} has no include patterns, so nothing would be extracted.`);
    }

    // Every payload lives here, and every one of them pins a hash that
    // authorises bytes onto some platform's disk — so the rules below are
    // applied identically to all of them, whichever platform they serve.
    if (typeof p.assets !== 'object' || Array.isArray(p.assets) || p.assets === null) {
      fail(`${where} assets must be an object keyed by platform slug.`);
    }
    if (Object.keys(p.assets).length === 0) {
      fail(
        `${where} names no assets, so it is offered on no platform at all. Drop the entry, or give it the platform payload it is missing.`,
      );
    }
    for (const [slug, asset] of Object.entries(p.assets)) {
      const assetWhere = `${where} asset '${slug}'`;
      if (!(ASSET_PLATFORMS as readonly string[]).includes(slug)) {
        fail(`${assetWhere} names an unknown platform. Known: ${ASSET_PLATFORMS.join(', ')}.`);
      }
      if (typeof asset !== 'object' || asset === null) {
        fail(`${assetWhere} is not an object.`);
      }
      if (!asset.url?.startsWith('https://')) fail(`${assetWhere} url is not https.`);
      if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) {
        fail(`${assetWhere} sha256 is not 64 lowercase hex characters.`);
      }
      if (!Number.isInteger(asset.downloadBytes) || asset.downloadBytes < 1) {
        fail(`${assetWhere} downloadBytes must be a positive integer.`);
      }
      // Present means "this platform's own patterns" and must say something;
      // to inherit the package's include, omit the field.
      if (asset.include !== undefined) {
        if (!Array.isArray(asset.include) || asset.include.length === 0) {
          fail(`${assetWhere} include is empty; omit it to inherit the package's patterns.`);
        }
      }
      if (asset.selfHosted !== undefined && typeof asset.selfHosted !== 'boolean') {
        fail(`${assetWhere} selfHosted must be true or false.`);
      }
      // The flag says who serves this url, so the url can be asked. A claim
      // that disagrees with it is the dangerous direction either way round: a
      // mirrored-looking entry actually served by us is a licence obligation
      // nobody has noticed, and a self-hosted-looking one served by the
      // project claims a responsibility we are not carrying.
      const servedByUs = asset.url.startsWith(HOSTED_URL_PREFIX);
      if (asset.selfHosted === true && !servedByUs) {
        fail(
          `${assetWhere} is marked selfHosted but its url is not ours (${HOSTED_URL_PREFIX}). Either it is a mirror of the project's own download — drop the flag — or it has not been uploaded yet.`,
        );
      }
      if (!asset.selfHosted && servedByUs) {
        fail(
          `${assetWhere} is served from our own bucket but is not marked selfHosted. Whoever serves the bytes conveys them: mark it, and check the licence obligations that follow.`,
        );
      }
    }

    const hostedPlatforms = Object.entries(p.assets)
      .filter(([, asset]) => asset.selfHosted)
      .map(([slug]) => slug);

    validateCategory(where, p.category);

    if (p.kind === 'content') {
      if (!p.installDir?.trim()) {
        fail(`${where} is kind 'content' but names no installDir to unpack into.`);
      }
      // installDir is joined to a path on the user's machine, so it must be a
      // plain folder name — the app enforces the same rule and would reject the
      // whole catalogue otherwise.
      if (/[/:\\]/.test(p.installDir!) || p.installDir === '..') {
        fail(`${where} installDir must be a plain folder name, not a path.`);
      }
      if (p.preserveStructure !== undefined && typeof p.preserveStructure !== 'boolean') {
        fail(`${where} preserveStructure must be true or false.`);
      }
    } else if (p.preserveStructure !== undefined) {
      // A VST3 bundle's layout is the installer's business — it finds the
      // outermost .vst3 itself — so a plugin asking to keep its own nesting is
      // asking for something that does not exist. The app refuses it too.
      fail(`${where} is a plugin but declares preserveStructure.`);
    } else if (p.installDir !== undefined) {
      // A plugin naming its own destination is either a mislabelled content
      // bundle or an attempt to land executable code outside the VST3 directory.
      fail(
        `${where} is kind 'plugin' but names an installDir. Plugins always install into the managed VST3 directory; if this is data, mark it kind 'content'.`,
      );
    }

    // The obligation that is easiest to lose track of. While a payload is
    // fetched from its own project, that project distributes it and supplies
    // its corresponding source. The moment Plectrify serves the binary, Plectrify is
    // the distributor and GPL §6 attaches — so ONE self-hosted platform is
    // enough to require the source, even where every other platform is still a
    // mirror. That asymmetry is exactly why the flag sits on the asset.
    if (hostedPlatforms.length > 0 && /GPL/i.test(p.licenseId) && !p.sourceUrl?.startsWith('https://')) {
      fail(
        `${where} serves its ${hostedPlatforms.join(', ')} payload itself and is copyleft (${p.licenseId}), but names no sourceUrl. Hosting a binary makes Plectrify its distributor, which requires the corresponding source to stay published and pointed at (GPL §6d). Re-pin to an upstream release, or publish the source and add sourceUrl.`,
      );
    }

    // Compiling a package makes Plectrify its producer, not merely its mirror, so
    // there has to be somewhere a user can go to see what was compiled. Every
    // one of its assets can only be served from our own bucket, too — there is
    // no upstream release holding a build that does not exist.
    if (p.builtFromSource) {
      const mirrored = Object.keys(p.assets).filter((slug) => !hostedPlatforms.includes(slug));
      if (mirrored.length > 0) {
        fail(
          `${where} is built from source but its ${mirrored.join(', ')} asset is not marked selfHosted. A binary Plectrify compiled exists nowhere else, so it can only be served by us.`,
        );
      }
      if (!p.sourceUrl?.startsWith('https://')) {
        fail(
          `${where} is built from source but names no sourceUrl. Point it at the exact tag that was compiled — it is the only record of what this binary was built from.`,
        );
      }
    }
  }

  // Resolved after every package has been seen, so declaration order in the
  // file does not matter. A dependency may only name a package this same
  // catalogue defines: it decides what is installed alongside the thing the
  // user asked for, so an id naming nothing would quietly install less than the
  // row promised, and one naming something outside the catalogue would be a
  // payload with no entry and no hash. The app applies the same rule and would
  // reject the catalogue outright.
  const byId = new Map(manifest.packages.map((p) => [p.id, p]));

  for (const p of manifest.packages) {
    if (p.dependsOn === undefined) continue;

    // One id, not a list. An array here would be stringified into nonsense by
    // the app and install the package on its own, which is the single outcome
    // this field exists to prevent.
    if (typeof p.dependsOn !== 'string' || !p.dependsOn.trim()) {
      fail(
        `package '${p.id}' dependsOn must be a single package id. A package needing two unrelated things is two packages.`,
      );
    }
    if (p.dependsOn === p.id) fail(`package '${p.id}' depends on itself.`);
    if (!seen.has(p.dependsOn)) {
      fail(`package '${p.id}' depends on unknown package '${p.dependsOn}'.`);
    }

    // A cycle installs fine — the app's resolver walks each chain once — but it
    // says two packages need each other, which nothing here can mean. Caught
    // while authoring, where an authoring mistake is still cheap.
    const chain = [p.id];

    for (let next: string | undefined = p.dependsOn; next; next = byId.get(next)?.dependsOn) {
      if (chain.includes(next)) {
        fail(`dependency cycle: ${[...chain, next].join(' -> ')}.`);
      }
      chain.push(next);
    }

    // A dependency must reach every platform the package that needs it does.
    // Otherwise the row advertises as installable there, the installer queues
    // the dependency first, and it fails on a package that platform was never
    // offered — a guaranteed failure the catalogue could have refused. Checked
    // per platform rather than "does it have any asset", because that is the
    // question the installer will ask.
    for (const slug of Object.keys(p.assets)) {
      for (const needed of chain.slice(1)) {
        if (byId.get(needed)?.assets?.[slug as AssetPlatform] === undefined) {
          fail(
            `package '${p.id}' is offered on ${slug} but depends on '${needed}', which is not. Either add that platform's asset to '${needed}', or drop it from '${p.id}' until it exists.`,
          );
        }
      }
    }
  }

  // Bundles are optional; a catalogue of loose packages is legitimate.
  const bundleIds = new Set<string>();

  for (const bundle of manifest.bundles ?? []) {
    const where = bundle.id ? `bundle '${bundle.id}'` : 'a bundle';

    for (const field of ['id', 'name', 'version'] as const) {
      if (!bundle[field]?.toString().trim()) fail(`${where} is missing '${field}'.`);
    }

    if (!SAFE_CATALOGUE_ID.test(bundle.id)) {
      fail(`${where} id must contain only letters, digits, dashes and underscores.`);
    }

    if (bundleIds.has(bundle.id)) fail(`duplicate bundle id '${bundle.id}'.`);
    bundleIds.add(bundle.id);

    const markerKey = `bundle-${bundle.id}`.toLowerCase();
    const markerOwner = markerKeys.get(markerKey);
    if (markerOwner) {
      fail(`${where} shares its install marker with ${markerOwner}. Rename one of their ids.`);
    }
    markerKeys.set(markerKey, where);

    if (!Array.isArray(bundle.packageIds) || bundle.packageIds.length === 0) {
      fail(`${where} names no packages.`);
    }

    // A bundle naming a package that is not defined would render as one the
    // user can never fully install, with no indication why. The app rejects
    // such a catalogue outright, so catching it here keeps that from ever
    // being published.
    for (const packageId of bundle.packageIds) {
      if (!seen.has(packageId)) fail(`${where} names unknown package '${packageId}'.`);
    }
  }

  // Links are optional, but a malformed one is dropped silently by both the app
  // and its normalizer — so the only place it can be caught is here, before it
  // is published as a section that renders empty.
  const linkUrls = new Set<string>();

  for (const link of manifest.links ?? []) {
    const where = link.label ? `link '${link.label}'` : 'a link';

    if (!link.label?.trim()) fail(`${where} is missing 'label'.`);

    // https only. These are handed to the user's default browser, and the
    // catalogue carrying them arrives over the network — the app applies the
    // same rule and drops anything else on sight.
    if (!link.url?.startsWith('https://')) fail(`${where} url must be https.`);

    if (linkUrls.has(link.url)) fail(`duplicate link url '${link.url}'.`);
    linkUrls.add(link.url);

    validateCategory(where, link.category);
  }
}

/**
 * Downloads every asset and checks it against its pinned hash.
 *
 * Link rot is how this feature decays between releases: tags stay put, assets
 * get re-cut. Run before publishing so a dead or changed pin fails here rather
 * than in a user's Packages panel.
 */
export async function verifyAssets(
  manifest: CatalogueManifest,
  log: (message: string) => void = console.log,
): Promise<void> {
  const { createHash } = await import('node:crypto');

  for (const p of manifest.packages) {
    // Every payload the manifest pins, whichever platform it serves.
    const targets = Object.entries(p.assets).map(([slug, asset]) => ({
      label: `${p.id} (${slug})`,
      url: asset!.url,
      sha256: asset!.sha256,
    }));

    for (const target of targets) {
      log(`  verifying ${target.label} ...`);

      const response = await fetch(target.url);
      if (!response.ok) {
        fail(`asset for '${target.label}' returned HTTP ${response.status} (${target.url}).`);
      }

      const hash = createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex');

      if (hash !== target.sha256) {
        fail(
          `asset for '${target.label}' hashed ${hash} but the manifest pins ${target.sha256}. Upstream re-cut the release. Re-pin deliberately, after checking what changed — in particular whether the plugin's parameter order moved, which would silently re-label the knob mappings in users' saved rigs and patches.`,
        );
      }
    }
  }
}
