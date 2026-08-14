/**
 * Archive, hash and upload a staged content pack.
 *
 * Used by `host`, which builds the content Plectrify itself owns — captures we
 * made, patches we authored — as opposed to `host-content`, which mirrors a
 * third party's freely-licensed files and therefore carries a lot of
 * provenance machinery this does not need.
 *
 * The shape deliberately matches host-content's tail: same key layout, same
 * immutable cache policy. A pack built here is indistinguishable to the
 * installer from one built there.
 *
 * THE ARCHIVE IS REPRODUCIBLE, which is what lets `host` compare a fresh build
 * against the hash the catalogue already pins and skip a pack whose files have
 * not changed. The determinism contract, in full: entries are the staged files
 * only (no directory entries), named by forward-slash relative path, added in
 * sorted order, each stamped to the fixed `zipEpoch()`, compressed at one fixed
 * level by the one zipper (fflate) used on every platform. Any change to any
 * of that changes the archive bytes, hence every pinned hash — deliberate,
 * one-publish events only. None of it may depend on the build host: not its
 * path separator, not its clock, and not its timezone (see `zipEpoch`).
 *
 * IT ALSO CARRIES UNIX FILE TYPES AND MODES, because a macOS VST3 bundle is not
 * a bag of plain files: its Mach-O under Contents/MacOS must arrive executable
 * or the bundle will not load, and an embedded framework points Versions/Current
 * at a sibling with a symlink. Archived as plain content, a directory symlink
 * fails outright (`readFileSync` on it raises EISDIR) and a file symlink is
 * silently followed, duplicating the bytes and breaking the bundle's signature
 * seal. So a link is stored as a link — its target is the entry's content — and
 * a file that is executable says so.
 *
 * That is a property of the staged tree, not of the build host, and `stage`
 * records nothing else: a plain 0644 data file gets no attributes at all, so an
 * OS-neutral content pack of captures and IRs zips to the same bytes on either
 * machine, which is what lets one archive serve every platform's asset entry.
 *
 * (This replaced PowerShell's Compress-Archive, which tied pack-building to
 * Windows. The swap changed the bytes once; the re-pin rode the same publish
 * that introduced macOS assets.)
 */
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { zipSync, type Zippable, type ZipOptions } from 'fflate';
import { wranglerInherit } from './wrangler.ts';

/**
 * Where the bucket is served from, and the one place that URL is written.
 *
 * A custom domain rather than the bucket's `pub-<hash>.r2.dev` dev URL, for two
 * reasons. Cloudflare rate limits r2.dev and positions it as a development
 * convenience, and this bucket is a trust root that gates plugin installs. And
 * the dev URL is the *bucket's* identity, not ours: recreate or move the bucket
 * and every pinned asset URL in every published catalogue revision dies —
 * including the ones baked into installers already in users' hands.
 *
 * The dev URL stays enabled on the bucket regardless, permanently. Builds up to
 * v0.1.0 have it compiled in and will never look anywhere else; it costs
 * nothing, serves the same objects at the same keys, and is not a migration to
 * finish. Nothing new should be pointed at it.
 */
export const R2_PUBLIC_BASE = 'https://cdn.plectrify.com';

/** The timestamp every archive entry records, on 1980-01-01 — the earliest date
    a zip entry can hold, so it is the one date nothing can disagree about.
    Built from **local** fields, which is not a slip: a zip stores a zone-less
    DOS stamp, and fflate derives one from `getFullYear()`/`getHours()`/…, so a
    `Date.UTC` instant reads back as a different wall clock in every zone —
    different bytes, hence a different hash, from the very same tree. West of
    UTC it does not even get that far: local 1979-12-31 is under DOS's floor and
    fflate throws `date not in range 1980-2099`. Local fields make those getters
    return exactly these fields everywhere (checked against all 418 IANA zones —
    1980-01-01 carries no offset change anywhere).

    A function rather than a constant for the same reason. A `Date` is an
    instant, and it is fflate that resolves it to fields, so a value built once
    at import would still be read in whatever zone is current at pack time;
    building it here keeps the two the same by construction.

    01:00 rather than midnight because every pack published so far was built in
    UTC+1 and carries that stamp (read it out of one with `unzip -l`). Keeping
    the hour is what makes this fix byte-neutral, so a pack still republishes
    only when its own files move; rounding it to 00:00 would restamp every
    archive ever built and re-pin them all to say nothing new. */
function zipEpoch(): Date {
  return new Date(1980, 0, 1, 1, 0, 0, 0);
}

/** One fixed compression level, part of the determinism contract above. */
const ZIP_LEVEL = 9;

/** Zip "os of origin" 3 — Unix. The mode bits below are only read back when an
    entry says it came from a Unix zipper, so the two travel together. */
const ZIP_OS_UNIX = 3;

/** `st_mode` file types, in the top nibble of the mode the external file
    attributes carry: a regular file and a symbolic link. */
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** The one mode an executable entry records. Not the staged file's own bits:
    those vary with the umask of whichever machine unpacked upstream's dmg, and
    the archive may not. What matters downstream is only that the bit is set —
    the installer chmods +x from it and reads nothing else. */
const EXECUTABLE_MODE = 0o755;

export function fail(script: string, message: string): never {
  console.error(`\n${script}: ${message}`);
  process.exit(1);
}

export interface PackResult {
  archivePath: string;
  sha256: string;
  downloadBytes: number;
}

/** Zip everything in `staged` and hash it. The archive's own file name is not
    part of its contents, so this says nothing about the version — see
    `assetLocation`, which is applied at upload time once the hash has decided
    whether there is a new version at all. */
export function buildArchive(options: {
  script: string;
  staged: string;
  work: string;
}): PackResult {
  const archivePath = join(options.work, 'pack.zip');

  const mtime = zipEpoch();
  const entries: Zippable = {};
  for (const rel of walk(options.staged).sort()) {
    entries[rel] = stage(join(options.staged, rel), mtime);
  }
  if (Object.keys(entries).length === 0) {
    fail(options.script, `nothing staged to archive in ${options.staged}.`);
  }

  mkdirSync(options.work, { recursive: true });
  writeFileSync(archivePath, zipSync(entries, { level: ZIP_LEVEL, mtime }));

  return {
    archivePath,
    sha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex'),
    downloadBytes: statSync(archivePath).size,
  };
}

/** One entry's content and the attributes it is stored with. A link's content
    is its target; a plain file's is its bytes. */
function stage(path: string, mtime: Date): [Uint8Array, ZipOptions] {
  const stats = lstatSync(path);

  if (stats.isSymbolicLink()) {
    // Stored, never followed: the target is the entry's content, and copying
    // what it points at instead would duplicate a framework into the bundle
    // that references it and invalidate the signature over both.
    const target = readlinkSync(path).split(sep).join('/');
    return [Buffer.from(target, 'utf8'), attributes(mtime, S_IFLNK | 0o777)];
  }

  const content = readFileSync(path);

  // Only an executable file records a mode; everything else stays exactly the
  // entry it has always been, so no already-published pack re-hashes.
  return (stats.mode & 0o111) === 0
    ? [content, { level: ZIP_LEVEL, mtime }]
    : [content, attributes(mtime, S_IFREG | EXECUTABLE_MODE)];
}

/** Unix mode bits live in the high half of a zip entry's external file
    attributes, and are only meaningful alongside the Unix os-of-origin. */
function attributes(mtime: Date, mode: number): ZipOptions {
  return { level: ZIP_LEVEL, mtime, os: ZIP_OS_UNIX, attrs: (mode << 16) >>> 0 };
}

/** Forward-slash relative paths of every file under `root`, depth-first. The
    caller sorts; this only enumerates.

    A symlink is an entry in its own right, never a directory to descend into:
    `Dirent.isDirectory()` is already false for one, and following a link into
    the tree it points at is how a bundle's Versions/Current would be archived
    twice — or, given a cycle, forever. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** Where a given version of a pack lives. Version-stamped and immutable: a
    refreshed pack is a new object rather than a mutation of this one, which is
    what lets the catalogue pin a hash at all. */
export function assetLocation(prefix: string, id: string, version: string) {
  const key = `${prefix}/${id}/plectrify-${id}-${version}.zip`;
  return { key, assetUrl: `${R2_PUBLIC_BASE}/${key}` };
}

export function upload(script: string, bucket: string, archivePath: string, key: string): void {
  console.log(`==> Uploading to r2://${bucket}/${key}`);
  if (
    !wranglerInherit([
      'r2', 'object', 'put', `${bucket}/${key}`,
      '--file', archivePath, '--remote',
      '--content-type', 'application/zip',
      '--cache-control', 'public, max-age=31536000, immutable',
    ])
  ) {
    fail(script, 'the upload failed.');
  }
}
