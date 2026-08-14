/**
 * Report which catalogue pins are behind their upstream project.
 *
 *   pnpm --dir packaging check-updates
 *
 * Answers "is this version outdated?" with evidence rather than a guess, for
 * every plugin at once. Read-only: it changes nothing and publishes nothing.
 *
 * A newer tag is NOT automatically a newer pin. Several of these projects cut
 * releases that ship no build for a given OS, and a pin can only point at a
 * release that actually carries that OS's asset — so that, not the newest tag,
 * is what this reports. Each platform in a package's `assets` is checked
 * independently, by the same code and in the same terms: a project can ship a
 * new Windows build and no mac build, or vice versa, and neither answer is the
 * one the other is measured against.
 *
 * The exception is a package Plectrify compiles itself (`builtFromSource`), where
 * a source-only tag IS a valid upgrade target for every platform we build.
 * Applying the per-OS asset filter there would hide the newest buildable
 * release and name an older one as "newer" — advising a downgrade. Neural Amp
 * Modeler is why: it stopped publishing Windows binaries after v0.7.13, so
 * measured by assets it looks frozen there forever while its source moves on.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scriptArgs } from './cli.ts';
import { readManifest } from './manifest.ts';

const packagingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    manifest: { type: 'string', default: resolve(packagingDir, 'catalogue.json') },
  },
});

interface Release {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string }[];
}

/** owner/repo from a GitHub project URL, or null for anything else. */
function repoOf(url: string): string | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Whether a release asset looks like a build for the given platform slug —
 *  one case per slug in `assets`, and no default. */
function isAssetFor(platform: string, name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('pdb') || n.includes('symbol')) return false; // debug symbols, not a build

  if (platform === 'windows-x64') return /win|windows/.test(n) && /\.(zip|exe)$/.test(n);
  if (platform === 'macos-arm64') return /mac|osx|darwin/.test(n) && /\.(zip|dmg|pkg)$/.test(n);
  return false;
}

const manifest = await readManifest(resolve(values.manifest!));

// Plugins only. Content packages are ours: they are assembled by host-content
// from sources that cut no releases, so asking GitHub whether one is behind
// would report every single one as uncheckable and bury the plugins that
// genuinely are.
const plugins = manifest.packages.filter((p) => p.kind === 'plugin');

let behind = 0;
let unknown = 0;
let pinCount = 0;

for (const plugin of plugins) {
  // Every pin this package carries, one per platform it is offered on, each
  // checked independently — upstream ships per-OS builds on its own schedule.
  const pins = Object.entries(plugin.assets).map(([platform, asset]) => ({
    platform,
    pinnedUrl: asset!.url,
    selfHosted: asset!.selfHosted === true,
  }));
  pinCount += pins.length;

  const label = (platform: string) => `${plugin.id} [${platform}]`.padEnd(40);

  const repo = repoOf(plugin.projectUrl);

  if (!repo) {
    for (const pin of pins) {
      console.log(`  ?  ${label(pin.platform)} ${plugin.version.padEnd(22)} not a GitHub project`);
      unknown++;
    }
    continue;
  }

  let releases: Release[];
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    releases = (await response.json()) as Release[];
  } catch (error) {
    for (const pin of pins) {
      console.log(
        `  ?  ${label(pin.platform)} ${plugin.version.padEnd(22)} ${(error as Error).message}`,
      );
      unknown++;
    }
    continue;
  }

  // A package we compile ourselves is not limited to releases that ship a
  // binary for the platform — a source-only tag is exactly what it consumes.
  // Filtering those out would make the newest *buildable* release invisible
  // and report an older one as "newer", i.e. advise a downgrade.
  const fromSource = plugin.builtFromSource === true;

  for (const pin of pins) {
    const usable = releases.filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        (fromSource || r.assets.some((a) => isAssetFor(pin.platform, a.name))),
    );

    if (usable.length === 0) {
      const why = fromSource ? 'no releases found' : `no ${pin.platform} releases found`;
      console.log(`  ?  ${label(pin.platform)} ${plugin.version.padEnd(22)} ${why}`);
      unknown++;
      continue;
    }

    const newest = usable[0]!;
    const skipped = releases.filter(
      (r) => !r.draft && !r.prerelease && !usable.includes(r) && r.published_at > newest.published_at,
    );

    // Primary signal: does the pinned asset still belong to the newest release?
    // That is the only check that works for a rolling tag, where the tag name
    // never changes but the asset behind it is replaced — comparing tags there
    // would report "behind" forever.
    const pinnedIsNewest = newest.assets.some((a) => a.browser_download_url === pin.pinnedUrl);

    // A self-hosted pin's url is ours and can never appear in an upstream
    // release's asset list, so for those the version is the only thing that can
    // be compared — asked of the asset rather than inferred, now that each one
    // says who serves it. A package mirrored on one platform and re-hosted on
    // the other gets the right question on each.
    const tag = newest.tag_name.replace(/^v/, '');
    const tagMatches = tag === plugin.version || newest.tag_name === plugin.version;

    // Unless the tag is a rolling one, which defeats both checks at once: the
    // url is ours so it is not in the release, and the tag name never changes
    // so it cannot carry the version either — leaving the pin "behind" forever
    // against a tag it can never match. What does move on such a release is the
    // asset *filename*, which carries the build's own date and commit; a
    // re-hosted entry pins that string as its version precisely because there
    // is nothing else to pin. So finding it on one of the newest release's
    // builds for this platform says the binary we re-hosted is still the one
    // upstream ships. Narrowed to this platform's assets, and only ever an
    // additional way to be current, because it is a substring test.
    const versionInNewestAsset = newest.assets.some(
      (a) => isAssetFor(pin.platform, a.name) && a.name.includes(plugin.version),
    );

    const current = pin.selfHosted
      ? tagMatches || versionInNewestAsset
      : pinnedIsNewest || tagMatches;

    const note = skipped.length
      ? ` (${skipped.map((r) => r.tag_name).join(', ')} ship no ${pin.platform} build)`
      : '';

    if (current) {
      console.log(`  ok ${label(pin.platform)} ${plugin.version.padEnd(22)} latest${note}`);
    } else {
      console.log(
        `  -> ${label(pin.platform)} ${plugin.version.padEnd(22)} newer: ${newest.tag_name} (${newest.published_at.slice(0, 10)})${note}`,
      );
      behind++;
    }
  }
}

console.log('');
if (behind === 0) {
  console.log(`All ${pinCount} pins are at the newest release they can use.`);
} else {
  console.log(
    `${behind} of ${pinCount} pins are behind. Update that platform's url, sha256 and downloadBytes together — never one without the others — and leave the other platforms' assets alone; then re-run validate --verify-assets before publishing. For a package marked builtFromSource, re-run build-plugin at the new tag on each platform instead: it emits that platform's whole asset.`,
  );
}
if (unknown > 0) console.log(`${unknown} could not be checked automatically; verify by hand.`);

// Rolling-tag entries are worth calling out: their asset is replaced in place,
// so the tag can look unchanged while the binary underneath has moved.
const rolling = plugins.filter((p) => /^\d{4}-\d{2}-\d{2}/.test(p.version));
if (rolling.length > 0) {
  console.log(
    `\nNote: ${rolling.map((p) => p.id).join(', ')} publish to a rolling tag, so a hash check (validate --verify-assets) is the only way to tell whether they moved.`,
  );
}
