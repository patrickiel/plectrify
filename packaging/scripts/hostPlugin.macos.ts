/**
 * The macOS half of `host-plugin`: get a VST3 out of an upstream .dmg or .pkg.
 *
 * NOTHING IS EXECUTED. Unlike the Windows half, which must run an installer,
 * a .dmg mounts and a .pkg expands as plain data: the payload is copied out,
 * never installed. That is also why this needs no uninstall step and can run on
 * the everyday machine.
 *
 * IT ONLY RUNS ON A MAC, and the guard is not ceremony. `hdiutil`, `pkgutil`
 * and `lipo` have no equivalents elsewhere, and — more to the point — a macOS
 * bundle's validity lives in POSIX permission bits, framework symlinks and a
 * code-signature seal that extracting on another OS would quietly drop. The
 * result would hash fine, validate fine and fail to load.
 *
 * Every bundle must carry an arm64 slice (checked): an Intel-only plugin cannot
 * load into the arm64-only Plectrify process.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Extraction, HostPluginContext, HostPluginPlatform } from './hostPlugin.ts';

export const macosHost: HostPluginPlatform = {
  platform: 'macos-arm64',

  options: {
    /** Which .vst3 bundles to take, repeatable. Omitted means all of them —
     *  see `extract`, where that default is argued. */
    bundle: { type: 'string', multiple: true },
  },

  requireHost: () => {
    if (process.platform !== 'darwin') {
      console.error(
        '\nhost-plugin: mounting a .dmg / expanding a .pkg needs macOS tooling, and a mac bundle\'s permissions, symlinks and signature would not survive extraction anywhere else. Run this on a Mac.',
      );
      process.exit(1);
    }
  },

  extract,
};

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Every .vst3 bundle directly reachable under `root` (not the copies nested
    inside another bundle). */
function findBundles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.vst3')) continue;
    const path = join(entry.parentPath, entry.name);
    if (!out.some((outer) => path.startsWith(`${outer}/`))) out.push(path);
  }
  return out;
}

async function extract(context: HostPluginContext): Promise<Extraction | null> {
  // Annotated, not inferred: TypeScript only narrows past a never-returning
  // call when the callee is a name with an explicit type.
  const fail: (message: string) => never = context.fail;

  const extracted = join(context.work, 'extracted');
  run('mkdir', ['-p', extracted]);

  const expandPkg = (pkgPath: string): void => {
    console.log(`==> Expanding ${basename(pkgPath)}`);
    const expandDir = join(context.work, `pkg-${basename(pkgPath)}`);
    const expand = run('pkgutil', ['--expand-full', pkgPath, expandDir]);
    if (!expand.ok) fail(`pkgutil --expand-full failed.\n${expand.output}`);
    for (const bundle of findBundles(expandDir)) {
      run('cp', ['-R', bundle, join(extracted, basename(bundle))]);
    }
  };

  if (context.dryRun) {
    console.log(`Would extract ${context.payloadName}.`);
    return null;
  }

  if (/\.dmg$/i.test(context.payloadName)) {
    console.log('==> Mounting the disk image');
    const mountPoint = join(context.work, 'mnt');
    const attach = run('hdiutil', [
      'attach', context.payloadPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint,
    ]);
    if (!attach.ok) fail(`hdiutil attach failed.\n${attach.output}`);
    try {
      // A dmg may hold the bundle directly, or a .pkg holding it.
      for (const bundle of findBundles(mountPoint)) {
        run('cp', ['-R', bundle, join(extracted, basename(bundle))]);
      }
      for (const entry of readdirSync(mountPoint, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name.endsWith('.pkg')) {
          expandPkg(join(entry.parentPath, entry.name));
        }
      }
    } finally {
      run('hdiutil', ['detach', mountPoint]);
    }
  } else if (/\.pkg$/i.test(context.payloadName)) {
    expandPkg(context.payloadPath);
  } else {
    fail(
      `don't know how to extract ${context.payloadName} — a plain zip needs no re-hosting, so point the catalogue's asset url straight at the upstream release and keep the project as its own distributor.`,
    );
  }

  // --- Pick the bundles, check every slice -----------------------------------
  const bundles = findBundles(extracted);
  if (bundles.length === 0) fail('the payload contained no .vst3 bundle.');

  // Everything the payload holds, by default — the same rule the Windows half
  // applies to whatever the installer added, and for the same reason: a release
  // shipping four reverbs ships four plugins, and a package that quietly
  // delivered one of them would install a quarter of what its row promises.
  // --bundle is the narrowing, for a payload that also carries something this
  // package is not offering; it names bundles rather than picking one, so
  // asking for two is not a special case.
  const wanted = context.options.bundle as string[] | undefined;
  const chosen = wanted?.length
    ? bundles.filter((bundle) => wanted.includes(basename(bundle)))
    : bundles;
  const missing = (wanted ?? []).filter(
    (name) => !bundles.some((bundle) => basename(bundle) === name),
  );
  if (missing.length > 0) {
    fail(
      `--bundle named ${missing.join(', ')}, which the payload does not hold (it has: ${bundles.map((b) => basename(b)).join(', ')}).`,
    );
  }

  const collected: string[] = [];
  const sliceNotes: string[] = [];

  for (const bundle of chosen) {
    const bundleName = basename(bundle);
    const macosDir = join(bundle, 'Contents/MacOS');
    const binaryName = existsSync(macosDir) ? readdirSync(macosDir)[0] : undefined;
    if (!binaryName) fail(`${bundleName} has no Contents/MacOS binary.`);
    const slices = run('lipo', ['-archs', join(macosDir, binaryName)]).output.trim();
    if (!slices.split(/\s+/).includes('arm64')) {
      fail(
        `${bundleName} carries no arm64 slice (has: ${slices || 'none readable'}) — it cannot load into the arm64-only Plectrify process.`,
      );
    }

    run('cp', ['-R', bundle, join(context.staged, bundleName)]);
    collected.push(bundleName);
    sliceNotes.push(`  ${bundleName} (${slices})`);
  }

  return {
    collected,
    notes: [
      'HOW IT WAS EXTRACTED',
      '--------------------',
      `Upstream ships this build as ${context.payloadName}, which cannot be unzipped`,
      'to a VST3. It was mounted (or expanded) as plain data — nothing from the',
      'payload was executed — and the bundles copied out unmodified.',
      '',
      `Bundles (${collected.length}) and their slices:`,
      ...sliceNotes,
    ],
  };
}
