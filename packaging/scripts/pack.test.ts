/**
 * The archive determinism contract, enforced. `host` decides whether a pack
 * changed by comparing a fresh build's hash against the catalogue's pin, so
 * "same tree, same bytes" is not an optimisation — it is what makes that
 * comparison mean anything. Run via `pnpm --dir packaging test`.
 */
import { strict as assert } from 'node:assert';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { buildArchive } from './pack.ts';

/** The external file attributes of every entry, by name — read from the central
    directory, since that is the only place a zip records them. */
function attributesByName(archivePath: string): Record<string, number> {
  const zip = readFileSync(archivePath);
  const out: Record<string, number> = {};

  // Walk the central directory headers from the first one; the end-of-central-
  // directory record gives its offset, and every header is self-describing.
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);

  while (zip.readUInt32LE(at) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    out[zip.toString('utf8', at + 46, at + 46 + nameLength)] = zip.readUInt32LE(at + 38);
    at += 46 + nameLength + extraLength + commentLength;
  }

  return out;
}

function makeTree(root: string): void {
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'patch.json'), '{"name":"JTM45"}');
  writeFileSync(join(root, 'assets', 'capture.nam'), Buffer.alloc(1024, 7));
  writeFileSync(join(root, 'assets', 'zz-last.wav'), Buffer.alloc(64, 1));
}

test('the same tree zips to the same bytes, twice', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const stagedA = join(work, 'a');
    const stagedB = join(work, 'b');
    makeTree(stagedA);
    makeTree(stagedB);

    // Wall-clock mtimes must not leak into the archive: give the second tree
    // visibly different ones and demand identical bytes anyway.
    utimesSync(join(stagedB, 'patch.json'), new Date('2001-02-03'), new Date('2001-02-03'));

    const a = buildArchive({ script: 'pack.test', staged: stagedA, work: join(work, 'outA') });
    const b = buildArchive({ script: 'pack.test', staged: stagedB, work: join(work, 'outB') });

    assert.equal(a.sha256, b.sha256);
    assert.deepEqual(readFileSync(a.archivePath), readFileSync(b.archivePath));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('entries are sorted forward-slash paths with no directory entries', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    makeTree(staged);

    const result = buildArchive({ script: 'pack.test', staged, work: join(work, 'out') });
    const names = Object.keys(unzipSync(readFileSync(result.archivePath)));

    // The exact entry list IS the contract: relative, forward slashes, sorted,
    // files only. The C++ installer normalises backslashes anyway, but a
    // deterministic archive must not depend on the build host's separator.
    assert.deepEqual(names, ['assets/capture.nam', 'assets/zz-last.wav', 'patch.json']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the same tree zips to the same bytes in every timezone', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  const tz = process.env.TZ;
  try {
    const staged = join(work, 'staged');
    makeTree(staged);

    // A zip stores a zone-less DOS stamp, and fflate derives it from the local
    // fields of the mtime it is handed — so the build host's timezone is as
    // much a determinism hazard as its path separator. Zones east and west of
    // UTC both, because west is the one that used to throw outright: a UTC
    // instant for 1980-01-01 is local 1979-12-31 there, below DOS's floor.
    const hashes = ['UTC', 'Europe/Zurich', 'America/Los_Angeles', 'Asia/Tokyo'].map((zone, i) => {
      process.env.TZ = zone;
      return buildArchive({ script: 'pack.test', staged, work: join(work, `out${i}`) }).sha256;
    });

    assert.equal(new Set(hashes).size, 1);
  } finally {
    // Assigning undefined would set the literal string "undefined", which is no
    // zone at all and silently leaves the rest of the run in UTC.
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    rmSync(work, { recursive: true, force: true });
  }
});

test('entries carry the published 1980-01-01 01:00 stamp', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    makeTree(staged);

    const zip = readFileSync(
      buildArchive({ script: 'pack.test', staged, work: join(work, 'out') }).archivePath,
    );

    // Every pack published so far carries this exact stamp, so it is part of
    // the pinned hashes rather than a free choice: moving it would make `host`
    // read unchanged packs as changed. Read from the first local file header —
    // DOS time at +10, date at +12 — since that is what the hash sees.
    const time = zip.readUInt16LE(10);
    const date = zip.readUInt16LE(12);
    assert.deepEqual(
      { y: 1980 + (date >> 9), m: (date >> 5) & 0xf, d: date & 0x1f, h: time >> 11 },
      { y: 1980, m: 1, d: 1, h: 1 },
    );
    assert.equal(time & 0x7ff, 0, 'minutes and seconds must be zero');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a plain data file records no attributes at all', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    makeTree(staged);

    const result = buildArchive({ script: 'pack.test', staged, work: join(work, 'out') });

    // What keeps one OS-neutral content pack serving every platform's asset:
    // a capture staged on a Mac and the same capture staged on Windows are the
    // same entry, because neither carries a mode.
    assert.deepEqual(Object.values(attributesByName(result.archivePath)), [0, 0, 0]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// POSIX only: Windows has no execute bit for chmod to set and no unprivileged
// symlinks, so neither shape can be staged there — which is also why a mac
// bundle may only ever be packed on a Mac.
const posix = { skip: process.platform === 'win32' && 'POSIX-only file modes' };

test('an executable file is stored as one', posix, () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    mkdirSync(join(staged, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(staged, 'Contents/MacOS/NeuralAmpModeler'), Buffer.alloc(32, 9));
    writeFileSync(join(staged, 'Contents/Info.plist'), '<plist/>');
    chmodSync(join(staged, 'Contents/MacOS/NeuralAmpModeler'), 0o755);

    const attributes = attributesByName(
      buildArchive({ script: 'pack.test', staged, work: join(work, 'out') }).archivePath,
    );

    // Regular file, 0755. Without it the installed bundle has no runnable
    // binary and the plugin never loads.
    assert.equal(attributes['Contents/MacOS/NeuralAmpModeler']! >>> 16, 0o100755);
    assert.equal(attributes['Contents/Info.plist'], 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a symlink is stored as a link to its target, not as what it points at', posix, () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    mkdirSync(join(staged, 'Frameworks/Foo.framework/Versions/A'), { recursive: true });
    writeFileSync(join(staged, 'Frameworks/Foo.framework/Versions/A/Foo'), Buffer.alloc(16, 3));
    symlinkSync('A', join(staged, 'Frameworks/Foo.framework/Versions/Current'));

    const archivePath = buildArchive({
      script: 'pack.test', staged, work: join(work, 'out'),
    }).archivePath;
    const entries = unzipSync(readFileSync(archivePath));
    const attributes = attributesByName(archivePath);

    const link = 'Frameworks/Foo.framework/Versions/Current';
    assert.equal(attributes[link]! >>> 28, 0xa, 'the entry must declare itself a symlink');
    assert.equal(Buffer.from(entries[link]!).toString('utf8'), 'A');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a changed byte changes the hash', () => {
  const work = mkdtempSync(join(tmpdir(), 'plectrify-pack-'));
  try {
    const staged = join(work, 'staged');
    makeTree(staged);
    const before = buildArchive({ script: 'pack.test', staged, work: join(work, 'out1') });

    writeFileSync(join(staged, 'patch.json'), '{"name":"JTM45","accent":"#f00"}');
    const after = buildArchive({ script: 'pack.test', staged, work: join(work, 'out2') });

    assert.notEqual(before.sha256, after.sha256);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
