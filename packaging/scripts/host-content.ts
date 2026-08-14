/**
 * Build and host a content pack (cabinet IRs) from freely-licensed sources.
 *
 *   pnpm --dir packaging host-content -- --id cab-irs --version 1
 *
 * WHY PLECTRIFY HOSTS THIS AND NOT AMP CAPTURES. Content is only ever bundled
 * when the rights holder has put it in the public domain or granted
 * redistribution outright. These IRs carry an explicit CC0 dedication in their
 * own handbooks. Amp captures do not clear that bar — TONE3000's terms forbid
 * mirroring their catalogue, and the large GPL-labelled .nam collection
 * relicenses other people's captures wholesale — so Plectrify ships none and
 * links out instead.
 *
 * The sources are pinned by SHA-256 like everything else, so a silently
 * re-cut upstream pack fails here rather than reaching users.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { scriptArgs } from './cli.ts';
import { R2_PUBLIC_BASE, buildArchive } from './pack.ts';
import { wranglerInherit } from './wrangler.ts';

interface Source {
  name: string;
  url: string;
  sha256: string;
  /** Rights statement, quoted from the pack's own documentation. */
  licence: string;
  author: string;
  /** Files to leave out, with the reason. CC0 permits adaptation, and a
   *  general-audience product should not surface every name in a metal IR
   *  pack in its browser. */
  exclude?: { file: string; why: string }[];
}

const SOURCES: Source[] = [
  {
    name: "Jester's Emerald Pack 1.0",
    url: 'https://www.jester-dyne-productions.com/content/files/2023/04/Emerald-Pack-1.0.zip',
    sha256: 'a5b3eeea4816bf94d85182341877b42876dfa0cd6c2c570cf6761933b0c79d70',
    author: 'Bastian Karschewski (Jester Dyne Productions)',
    licence:
      'CC0 1.0 Universal (public domain dedication), stated in the pack handbook: "CC0 allows reusers to distribute, remix, adapt, and build upon the material in any medium or format, with no conditions." and "All IR\'s are completely free to use in your private and commercial Projects."',
  },
  {
    name: "Jester's Brutal Pack 1.0",
    url: 'https://www.jester-dyne-productions.com/content/files/2023/04/JestersBrutalPack_1.0.zip',
    sha256: '299dc053f01ebd1e980459adc48f9c6b8a8c7af91917b4f946512eefdbb311ea',
    author: 'Bastian Karschewski (Jester Dyne Productions)',
    licence:
      'CC0 1.0 Universal (public domain dedication), stated in the pack handbook, same wording as the Emerald Pack.',
    exclude: [
      {
        file: '9_Devils_Cunnilingus',
        why: 'crude filename; it would appear verbatim in the IR browser of a general-audience product. CC0 explicitly permits adapting the set, and dropping one file changes nothing about the rest.',
      },
    ],
  },
];

/** Sample rate read from a WAV's fmt chunk, or null if it is not a PCM WAV.
 *
 *  Selecting by header rather than by filename: these packs ship the same
 *  impulses at two rates in folders named "44.1kHz" and "48kHz", and matching
 *  on the path would silently start picking the wrong set the moment an
 *  upstream pack renamed a folder — with no symptom beyond every IR being at
 *  the wrong rate. */
function wavSampleRate(path: string): number | null {
  const b = readFileSync(path);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF') return null;

  // Walk the chunk list rather than assuming fmt is at a fixed offset: these
  // files carry LIST/INFO metadata ahead of it.
  let offset = 12;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === 'fmt ') return b.readUInt32LE(offset + 12);
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  return null;
}

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    id: { type: 'string', default: 'cab-irs' },
    /** One rate for the whole pack. A convolution loader resamples to the host
     *  rate anyway, so shipping both doubles the download and puts two
     *  near-identical names in the user's IR browser for no benefit. */
    rate: { type: 'string', default: '48000' },
    version: { type: 'string', default: '1' },
    bucket: { type: 'string', default: 'plectrify' },
    prefix: { type: 'string', default: 'plugins/v1/content' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`\nhost-content: ${message}`);
  process.exit(1);
}

/** Unpack a zip into `dest`, skipping macOS resource-fork noise. Node-native
 *  (fflate) rather than a shelled-out archiver, so this runs on any OS. */
function unzipTo(bytes: Buffer, dest: string): void {
  const entries = unzipSync(bytes, { filter: (file) => !file.name.includes('__MACOSX') });
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // directory entry
    const target = join(dest, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/** Every file under `root` with one of the given lowercase extensions. */
function filesUnder(root: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

const work = join(tmpdir(), `plectrify-content-${values.id}`);
await rm(work, { recursive: true, force: true });
const staged = join(work, 'staged');
await mkdir(staged, { recursive: true });

const manifestLines: string[] = [
  `Plectrify content pack: ${values.id} v${values.version}`,
  '',
  `Cabinet impulse responses, all at ${values.rate} Hz. Redistributed under the terms`,
  'their authors set.',
  'Every file here is public-domain dedicated by its creator; Plectrify adds nothing',
  'and claims nothing. The original handbooks are included so the capture details',
  'and the authors\' own words travel with the audio.',
  '',
];

for (const source of SOURCES) {
  console.log(`==> ${source.name}`);

  const response = await fetch(source.url);
  if (!response.ok) fail(`${source.name} returned HTTP ${response.status}.`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');

  if (hash !== source.sha256) {
    fail(
      `${source.name} hashed ${hash} but is pinned at ${source.sha256}. The upstream pack changed — re-check its licence and contents before re-pinning.`,
    );
  }

  const unpacked = join(work, `unpacked-${source.sha256.slice(0, 8)}`);
  try {
    unzipTo(bytes, unpacked);
  } catch (error) {
    fail(`could not unpack ${source.name}: ${(error as Error).message}`);
  }

  const wanted = Number(values.rate);
  const all = filesUnder(unpacked, ['.wav']);
  const wavs = all.filter((w) => wavSampleRate(w) === wanted);

  if (wavs.length === 0) {
    const seen = [...new Set(all.map(wavSampleRate))].join(', ');
    fail(
      `${source.name} has no ${wanted} Hz impulses (rates present: ${seen || 'none readable'}). Pass --rate to pick one the pack actually ships.`,
    );
  }

  const excluded = source.exclude ?? [];
  const kept = wavs.filter((w) => !excluded.some((e) => w.includes(e.file)));

  manifestLines.push(
    `${source.name}`,
    `  Source:   ${source.url}`,
    `  SHA-256:  ${source.sha256}`,
    `  Author:   ${source.author}`,
    `  Licence:  ${source.licence}`,
    `  Included: ${kept.length} impulse responses at ${values.rate} Hz`,
  );
  for (const e of excluded) manifestLines.push(`  Excluded: ${e.file} - ${e.why}`);
  manifestLines.push('');

  for (const wav of kept) {
    copyFileSync(wav, join(staged, basename(wav)));
  }

  // The handbooks carry the capture details and the CC0 statement in the
  // author's own words — the provenance is worth more than the few hundred KB.
  for (const doc of filesUnder(unpacked, ['.pdf'])) {
    copyFileSync(doc, join(staged, basename(doc)));
  }

  console.log(
    `    ${kept.length} impulses staged at ${values.rate} Hz (of ${all.length} in the pack)` +
      `${excluded.length ? `, ${excluded.length} excluded` : ''}`,
  );
}

await writeFile(join(staged, 'PROVENANCE.txt'), manifestLines.join('\n'), 'utf8');

const archiveName = `plectrify-${values.id}-${values.version}.zip`;
const archivePath = join(work, archiveName);

// The one reproducible zipper (pack.ts) rather than a second archiver: the
// bytes, and so the pinned hash, must not depend on which script built a pack.
const built = buildArchive({ script: 'host-content', staged, work });
await rename(built.archivePath, archivePath);

const archiveHash = built.sha256;
const archiveBytes = built.downloadBytes;

if (values['dry-run']) {
  console.log(`\nBuilt ${archiveName} (${archiveBytes} bytes, ${archiveHash}). Not uploaded (--dry-run).`);
  process.exit(0);
}

const key = `${values.prefix}/${values.id}/${archiveName}`;
console.log(`==> Uploading to r2://${values.bucket}/${key}`);

if (
  !wranglerInherit([
    'r2', 'object', 'put', `${values.bucket}/${key}`,
    '--file', archivePath, '--remote',
    '--content-type', 'application/zip',
    // Immutable: the name carries the version, so a refreshed pack is a new
    // object rather than a mutation of this one.
    '--cache-control', 'public, max-age=31536000, immutable',
  ])
) {
  fail('the upload failed.');
}

console.log('\nHosted. Catalogue entry:\n');
console.log(
  JSON.stringify(
    {
      id: values.id,
      // kind:'content' is what keeps this out of the VST3 load path — it
      // unpacks into installDir and is never loaded as code. Never change it to
      // 'plugin' to make something "work".
      kind: 'content',
      category: 'CHANGE ME',
      version: values.version,
      installDir: values.id,
      include: ['*.wav', '*.pdf', '*.txt'],
      // Mirrored files with no baked-in paths are OS-neutral, so every
      // platform is pointed at the one object. That is a claim about the
      // payload, not a formality: if a pack ever contains something that must
      // differ per OS, drop the platforms it does not suit rather than
      // shipping them bytes that do not fit.
      assets: Object.fromEntries(
        ['macos-arm64', 'windows-x64'].map((platform) => [
          platform,
          {
            url: `${R2_PUBLIC_BASE}/${key}`,
            sha256: archiveHash,
            downloadBytes: archiveBytes,
            // This script just uploaded it, so both platforms are served by us.
            selfHosted: true,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log(
  '\nMerge that into packaging/catalogue.json — setting `category` to the panel section it\n' +
    'belongs under (a heading, or a path like ["Effects", "Reverb"] for a subsection), and\n' +
    '`installDir` to the folder it should unpack into — then run publish-catalogue.\n\n' +
    'When re-hosting a later version, replace EVERY platform\'s asset: the previous\n' +
    'archive stays live in R2, so a stale pin keeps serving the old pack to whichever\n' +
    'platform it was left on.',
);
