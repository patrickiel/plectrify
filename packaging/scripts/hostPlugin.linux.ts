/**
 * The Linux half of `host-plugin`: get a VST3 out of an upstream tarball.
 *
 * WHY A TARBALL NEEDS RE-HOSTING AT ALL. Linux projects ship their builds as
 * `.tar.gz` / `.tar.xz` far more often than as zips, and the app only unzips
 * (`juce::ZipFile`) — it will not grow a tar reader for a handful of packages,
 * and a catalogue asset must yield a .vst3 by unpacking alone. The bundles
 * inside are usually already in VST3 bundle layout, with the shared object at
 * `Contents/x86_64-linux/<name>.so`, so this is the mildest of the three
 * routes: unpack, pick the bundles, re-zip them unmodified.
 *
 * NOTHING IS EXECUTED. The tarball is unpacked by the system `tar` as plain
 * data — GNU tar strips a leading `/` and refuses `..` members by default —
 * and every bundle is checked by reading its ELF header, never by loading it.
 *
 * IT ONLY RUNS ON LINUX, for the same reason the mac half only runs on a Mac:
 * a bundle's validity lives partly in POSIX bits. The archiver records an
 * executable file's mode, and an extraction on Windows would hand it none.
 *
 * Every bundle must carry a 64-bit x86-64 shared object (checked): an arm64 or
 * i686 build would hash fine, validate fine and fail to load into the x86-64
 * Plectrify process — and Dragonfly's release ships five Linux architectures
 * side by side, so picking the wrong tarball is an easy mistake to make.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chooseBundles, findBundles } from './hostPlugin.ts';
import type { Extraction, HostPluginContext, HostPluginPlatform } from './hostPlugin.ts';

export const linuxHost: HostPluginPlatform = {
  platform: 'linux-x64',

  options: {
    /** Which .vst3 bundles to take, repeatable. Omitted means all of them —
     *  see chooseBundles, where that default is argued. */
    bundle: { type: 'string', multiple: true },
  },

  requireHost: () => {
    if (process.platform !== 'linux') {
      console.error(
        '\nhost-plugin: a Linux bundle\'s executable bits would not survive extraction on this OS. Run this on Linux.',
      );
      process.exit(1);
    }
  },

  extract,
};

/** The compressions GNU tar recognises by itself from the file name. */
const TARBALL = /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tar\.zst)$/i;

/** ELF `e_machine` for x86-64. */
const EM_X86_64 = 0x3e;

/** What the ELF header says the file is, or why it is not one. Read by hand
    (20 bytes) rather than through `file`, which not every machine has and
    whose wording is not a contract. */
function elfKind(path: string): { ok: true; label: string } | { ok: false; why: string } {
  const header = Buffer.alloc(20);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) < header.length) return { ok: false, why: 'too short to be ELF' };
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) return { ok: false, why: 'not an ELF file' };
  const is64 = header[4] === 2;
  const little = header[5] === 1;
  const machine = little ? header.readUInt16LE(18) : header.readUInt16BE(18);
  if (!is64 || !little || machine !== EM_X86_64) {
    return {
      ok: false,
      why: `ELF ${is64 ? '64' : '32'}-bit, ${little ? 'little' : 'big'}-endian, machine 0x${machine.toString(16)}`,
    };
  }
  return { ok: true, label: 'ELF 64-bit x86-64' };
}

async function extract(context: HostPluginContext): Promise<Extraction | null> {
  // Annotated, not inferred: TypeScript only narrows past a never-returning
  // call when the callee is a name with an explicit type.
  const fail: (message: string) => never = context.fail;

  if (!TARBALL.test(context.payloadName)) {
    fail(
      /\.zip$/i.test(context.payloadName)
        ? `${context.payloadName} is a zip — a plain zip needs no re-hosting, so point the catalogue's asset url straight at the upstream release and keep the project as its own distributor.`
        : `don't know how to extract ${context.payloadName}: the Linux route reads tarballs (.tar, .tar.gz, .tar.xz, .tar.bz2, .tar.zst).`,
    );
  }

  if (context.dryRun) {
    console.log(`Would extract ${context.payloadName}.`);
    return null;
  }

  console.log(`==> Unpacking ${context.payloadName}`);
  const extracted = join(context.work, 'extracted');
  mkdirSync(extracted, { recursive: true });
  // --no-same-owner: the tarball's uid/gid (a CI runner's) mean nothing here.
  // Modes are kept — they are what this route exists to preserve.
  const untar = spawnSync('tar', ['-xf', context.payloadPath, '-C', extracted, '--no-same-owner'], {
    encoding: 'utf8',
  });
  if (untar.status !== 0) fail(`tar failed.\n${untar.stdout ?? ''}${untar.stderr ?? ''}`);

  const chosen = chooseBundles(
    findBundles(extracted),
    context.options.bundle as string[] | undefined,
    fail,
  );

  const collected: string[] = [];
  const binaryNotes: string[] = [];

  for (const bundle of chosen) {
    const bundleName = basename(bundle);
    const archDir = join(bundle, 'Contents/x86_64-linux');
    const objects = existsSync(archDir)
      ? readdirSync(archDir).filter((name) => name.endsWith('.so') && lstatSync(join(archDir, name)).isFile())
      : [];
    if (objects.length === 0) {
      fail(
        `${bundleName} has no Contents/x86_64-linux/*.so — either it is not in VST3 bundle layout, or this is another architecture's tarball.`,
      );
    }
    for (const object of objects) {
      const kind = elfKind(join(archDir, object));
      if (!kind.ok) {
        fail(`${bundleName}/Contents/x86_64-linux/${object} is ${kind.why}; it cannot load into the x86-64 Plectrify process.`);
      }
      binaryNotes.push(`  ${bundleName}: ${object} (${kind.label})`);
    }

    // -a keeps modes and leaves links as links, which the archiver records.
    const copy = spawnSync('cp', ['-a', bundle, join(context.staged, bundleName)], { encoding: 'utf8' });
    if (copy.status !== 0) fail(`copying ${bundleName} failed.\n${copy.stderr ?? ''}`);
    collected.push(bundleName);
  }

  return {
    collected,
    notes: [
      'HOW IT WAS EXTRACTED',
      '--------------------',
      `Upstream ships this build as ${context.payloadName}, a tarball the app`,
      'cannot unpack (it only unzips). It was unpacked as plain data — nothing',
      'from the payload was executed — and the bundles copied out unmodified,',
      'executable bits included.',
      '',
      `Bundles (${collected.length}) and their shared objects:`,
      ...binaryNotes,
    ],
  };
}
