/**
 * Platform-neutral plumbing shared by the dev-loop and release scripts
 * (run.windows.ts / run.macos.ts / release.windows.ts / release.macos.ts):
 * thin spawn helpers that actually fail on failure, the repo root, hashing,
 * and the Vite dev-server probe both dev loops use.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fail(message: string): never {
  console.error(`\nerror: ${message}`);
  process.exit(1);
}

export interface RunOptions {
  cwd?: string;
  /** Windows needs a shell to launch .cmd shims (pnpm, winget). Never used
      with untrusted argument strings — and see `pnpm()` for why a shell also
      means the arguments have to be quoted. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Run a command with inherited stdio; exit on a non-zero status. The default
    the .ps1 scripts had to build by hand (Assert-NativeSuccess / Invoke-Native)
    — never continue past a failed step to a stale launch or a broken package. */
export function run(step: string, command: string, args: string[], options: RunOptions = {}): void {
  console.log(`==> ${step}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: options.shell ?? false,
    env: options.env,
  } satisfies SpawnSyncOptions);
  if (result.status !== 0) fail(`${step} failed with exit code ${result.status ?? 'none'}.`);
}

/** Run pnpm — the one command these scripts cannot spawn directly, and so the
    one whose arguments have to be quoted.

    pnpm's Windows entry point is `pnpm.cmd`, and Node refuses to launch a .cmd
    without a shell. With `shell: true` it builds cmd.exe's command line by
    joining the arguments with single spaces and quoting none of them, so any
    argument carrying a space arrives as two — a checkout under "Program Files",
    a `--dir` beneath it, a release title. Quoting here keeps that contained to
    the one caller that needs it: everything else the scripts run (gh, git,
    cmake, ctest, curl, ISCC) is a real executable spawned shell-free, where the
    arguments reach it verbatim. Off Windows pnpm is an executable too and none
    of this applies.

    Same lesson as packaging/scripts/wrangler.ts, which avoids the shell
    outright for the same reason. */
export function pnpm(step: string, args: string[], options: { cwd?: string } = {}): void {
  const windows = process.platform === 'win32';
  run(step, 'pnpm', windows ? args.map(quoteForCmd) : args, { ...options, shell: windows });
}

/** cmd.exe quoting, for arguments this repo authors and a shell it cannot
    avoid. `/s` makes cmd strip only the outermost pair Node adds and pass the
    rest through, so an inner quoted argument survives to pnpm intact; anything
    cmd would otherwise split on or interpret goes inside quotes. */
function quoteForCmd(argument: string): string {
  return /[\s"&^|<>()]/.test(argument) ? `"${argument.replace(/"/g, '""')}"` : argument;
}

/** Run and capture stdout, '' on failure. For probes, never for build steps. */
export function capture(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    shell: options.shell ?? false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? (result.stdout ?? '') : '';
}

/** Exit code of a command whose failure is an answer, not an error ("that tag
    does not exist yet"). Output is discarded. */
export function probe(command: string, args: string[], options: RunOptions = {}): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'ignore',
    shell: options.shell ?? false,
  });
  return result.status ?? 1;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** What is on the Vite dev port: 'free', Plectrify's 'vite', or 'foreign'.
    A bare TCP connect is not enough — anything can hold 5173, and then the app
    renders the wrong UI, which reads as "the app is broken" rather than
    "wrong server". Verify both Vite's client module and the Plectrify
    application-name sentinel in the served index. fetch() resolves localhost
    the same dual-stack way the app's own navigation does, so Vite binding
    only the IPv6 loopback (which broke raw-socket probes) is a non-issue. */
export async function devServerStatus(): Promise<'free' | 'vite' | 'foreign'> {
  const probeUrl = async (path: string) => {
    try {
      const response = await fetch(`http://localhost:5173${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  };

  const index = await probeUrl('/');
  if (index === null) return 'free';

  const vite = await probeUrl('/@vite/client');
  const sentinel = '<meta name="application-name" content="Plectrify" />';
  return vite !== null && index.includes(sentinel) ? 'vite' : 'foreign';
}

/** Every patch CMake applies to the fetched JUCE tree, declared once for both
    release scripts' provenance gates: the tree they publish as corresponding
    source must be exactly this and nothing more.

    `marker` is a string the patch introduces, so "is it applied?" is answered
    by reading the file rather than by trusting the configure step; `file` is
    which source it touches. Every patch appears on both platforms even though
    each fixes one OS — CMake applies them all everywhere and each is guarded
    internally, so there is one patched tree and one answer to what a binary
    was built from. */
export const JUCE_PATCHES = [
  {
    patch: 'cmake/juce-disable-webview2-zoom.patch',
    file: 'modules/juce_gui_extra/native/juce_WebBrowserComponent_windows.cpp',
    marker: 'PLECTRIFY_DISABLE_WEBVIEW2_ZOOM',
  },
  {
    patch: 'cmake/juce-vst3-no-mac-content-scale.patch',
    file: 'modules/juce_audio_processors/format_types/juce_VST3PluginFormat.cpp',
    marker: 'PLECTRIFY_NO_MAC_CONTENT_SCALE',
  },
  {
    patch: 'cmake/juce-vst3-scale-before-attach.patch',
    file: 'modules/juce_audio_processors/format_types/juce_VST3PluginFormat.cpp',
    marker: 'PLECTRIFY_SCALE_BEFORE_ATTACH',
  },
  {
    patch: 'cmake/juce-no-double-escape-url.patch',
    file: 'modules/juce_gui_extra/native/juce_WebBrowserComponent_mac.mm',
    marker: 'PLECTRIFY_NO_DOUBLE_ESCAPE_URL',
  },
  {
    patch: 'cmake/juce-graph-host-owned-bypass.patch',
    file: 'modules/juce_audio_processors_headless/processors/juce_AudioProcessorGraph.cpp',
    marker: 'PLECTRIFY_HOST_OWNED_BYPASS',
  },
] as const;

/** What `git diff --name-only` must report for the patched JUCE tree, and
    nothing else — the sorted, *distinct* files JUCE_PATCHES touches.

    Distinct because two patches can land in the same source, as the VST3 pair
    do: they are separate fixes with separate markers, but git names a changed
    file once however many patches reached it. */
export const JUCE_PATCHED_FILES = [...new Set(JUCE_PATCHES.map(({ file }) => file))].sort();

/** Every CTest target, declared once for the two dev-loop scripts and the two
    release scripts.

    All four must build all of them before running ctest: a target that is not
    built is not skipped, it is run as whatever stale binary the tree still has
    — or, on a fresh tree, reported "Not Run" and failed. Declared here because
    it drifted the moment it was written out four times. */
export const TEST_TARGETS = [
  'PlectrifyTests',
  'PlectrifyRackTests',
  'PlectrifyLooperTests',
  'PlectrifyCatalogueTests',
  'PlectrifyNamStateTests',
  'PlectrifyTone3000AuthTests',
  'PlectrifyTone3000LibraryTests',
  'PlectrifyMetronomeTests',
  'PlectrifyStandbyTests',
] as const;

/** A plugin Plectrify ships inside the installer rather than offers for download
    (packaging/bundled-plugins.json). */
export interface BundledPlugin {
  id: string;
  name: string;
  version: string;
  licenseId: string;
  licenseUrl: string;
  projectUrl: string;
  sourceUrl: string;
  builtFromSource?: boolean;
  /** The .vst3 the archive is expected to contain, checked after extraction. */
  bundleName: string;
  assets: Record<string, { url: string; sha256: string; downloadBytes?: number }>;
}

/** The shipped-plugin manifest, for the platform a release is being built on.

    Both release scripts read this rather than the catalogue: these are not
    packages any more (nothing offers, installs or uninstalls them) — they are
    part of the application, and the only thing either script needs is a pinned
    URL and hash to stage from. */
export function bundledPluginsFor(platformSlug: string): (BundledPlugin & {
  asset: { url: string; sha256: string; downloadBytes?: number };
})[] {
  const path = join(ROOT, 'packaging', 'bundled-plugins.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { plugins?: BundledPlugin[] };

  return (manifest.plugins ?? []).map((plugin) => {
    const asset = plugin.assets?.[platformSlug];
    // A shipped plugin with no build for this platform is not a smaller
    // release, it is a broken one: the app assumes it is there. Refuse rather
    // than produce an installer that looks complete.
    if (!asset?.url || !asset.sha256)
      fail(`${plugin.id} has no ${platformSlug} asset in packaging/bundled-plugins.json.`);
    return { ...plugin, asset };
  });
}

/** Download and verify the shipped plugins' archives for a platform, returning
    each with the local path of its (hash-checked) archive.

    Shared by the release scripts and the dev loops on purpose: a Debug tree has
    no installer to stage from, so without this a developer's machine has no
    Neural Amp Modeler at all — and since it left the catalogue there is no
    longer a panel to install it from either. Staging the same pinned archive
    the installer uses is what makes the dev loop match a shipped install.

    Extraction is left to the caller: the two platforms need different tools
    (tar.exe on Windows; ditto on macOS, which preserves the permission bits and
    symlinks a signed bundle cannot survive without). */
export function fetchBundledPluginArchives(platformSlug: string): {
  plugin: ReturnType<typeof bundledPluginsFor>[number];
  archive: string;
}[] {
  const plugins = bundledPluginsFor(platformSlug);
  if (plugins.length === 0) return [];

  const cacheRoot = join(ROOT, '.release-cache');
  mkdirSync(cacheRoot, { recursive: true });

  return plugins.map((plugin) => {
    const archive = join(cacheRoot, `${plugin.id}-${plugin.version}-${platformSlug}.zip`);

    if (!existsSync(archive)) {
      console.log(`==> Downloading ${plugin.name} ${plugin.version}`);
      run('download plugin', 'curl', ['-fsSL', '-o', archive, plugin.asset.url]);
    }

    const actual = sha256File(archive);
    if (actual !== plugin.asset.sha256.toLowerCase()) {
      // Never silently re-fetch: the pin is what makes a downloaded binary
      // equivalent to one we built, and a mismatch is the case it exists for.
      rmSync(archive, { force: true });
      fail(
        `SHA-256 mismatch for ${plugin.name}. Expected ${plugin.asset.sha256}, got ${actual}. ` +
          'The cached copy has been discarded; if the build legitimately changed, update ' +
          'packaging/bundled-plugins.json.',
      );
    }

    return { plugin, archive };
  });
}
