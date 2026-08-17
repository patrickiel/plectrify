/**
 * Build the Svelte UI + the native app, then launch it — the Windows dev loop,
 * dispatched by `pnpm app` (run.ts picks this file on win32). Modes match
 * run.macos.ts exactly:
 *
 *   pnpm app                    Default HMR loop: start the Vite dev server +
 *                               launch the app pointed at http://localhost:5173.
 *                               Edit a .svelte file and it hot-reloads live
 *                               inside the real host. (Debug; real audio.)
 *   pnpm app --ui-only          Fast path: rebuild ui/dist + relaunch the exe,
 *                               skipping cmake. Serves the baked UI.
 *   pnpm app --dist             Full build + gate: UI (format + check + test +
 *                               build), native (cmake), native tests (ctest),
 *                               then run serving the baked ui/dist.
 *   pnpm app --dist --no-ui     Full build, skip the UI build.
 *   pnpm app --dist --no-run    Full build only, don't launch.
 *   pnpm app --clean            Rebuild the native target from scratch. Reach
 *                               for this when the app starts crashing right
 *                               after a header change: a stale incremental
 *                               build can link objects compiled against two
 *                               versions of a class, and the mismatched object
 *                               size corrupts the heap at startup.
 *   pnpm app --dist --config Release
 *                               Release build (stages ui/ beside the exe).
 *   pnpm app --plugin           Build the Debug VST3 instead of the app and
 *                               install it for this user's DAWs
 *                               (%LOCALAPPDATA%\Programs\Common\VST3). Starts
 *                               Vite like the default loop; launch the DAW
 *                               with PLECTRIFY_DEV_URL set for live HMR. A
 *                               Debug .vst3 needs no staging at all — UI,
 *                               catalogue and bundled plugins resolve from
 *                               the source tree. Release staging for the
 *                               plugin is release plumbing, not built yet, so
 *                               --plugin refuses --dist and --ui-only.
 *
 * This replaced run-windows.ps1 one-for-one; the Windows-only hazards it
 * carried live on in windows.ts (the MSBuild .tlog interrupted-build
 * marker, the WebView2 orphan hunt, the Event Log crash lookup).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ROOT, TEST_TARGETS, devServerStatus, fail, fetchBundledPluginArchives, pnpm, run,
} from './shared.ts';
import {
  assertWindows,
  clearBuildMarker,
  copyUiBesideExe,
  devPortOwner,
  exePath,
  findCMake,
  findCTest,
  markerDemandsClean,
  setBuildMarker,
  startApp,
  stopApp,
} from './windows.ts';

assertWindows('run.windows.ts');

const { values } = parseArgs({
  options: {
    dist: { type: 'boolean', default: false },
    'ui-only': { type: 'boolean', default: false },
    'no-ui': { type: 'boolean', default: false },
    'no-run': { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false },
    plugin: { type: 'boolean', default: false },
    config: { type: 'string', default: 'Debug' },
  },
});

const config = values.config!;
const uiDir = join(ROOT, 'ui');

if (values.plugin && (values.dist || values['ui-only'])) {
  fail('--plugin is the Debug dev loop only for now; staging a Release .vst3 is release plumbing.');
}

let needsClean = values.clean;

/** Wraps every `cmake --build`. Owns the interrupted-build marker, and spends
    the --clean-first on the first target only: the rest of a --dist run
    compiles against the tree that target just rebuilt, so cleaning again per
    target would triple the build for no extra safety. */
function nativeBuild(cmake: string, target: string): void {
  if (!needsClean && markerDemandsClean()) {
    console.log('==> Last native build did not finish - rebuilding from scratch');
    needsClean = true;
  }

  const extra = needsClean ? ['--clean-first'] : [];
  needsClean = false;

  setBuildMarker();
  run(`Native build (${target})`, cmake, [
    '--build', join(ROOT, 'build'), '--config', config, '--target', target, ...extra,
  ]);
  clearBuildMarker();
}

/** Locked, reproducible UI install. Rewriting the lockfile must be an explicit
    action (it would later trip the release script's clean-tree gate), never a
    build side effect. */
/** Put the plugins Plectrify *ships* where a Debug build looks for them
    (third_party/plugins, wired as PLECTRIFY_BUNDLED_PLUGIN_DIR in CMakeLists).

    A release stages these into the installation; a dev tree has no
    installation, so without this the dev loop runs an app that is missing a
    plugin it assumes is present — and since Neural Amp Modeler left the
    catalogue, there is no panel to install it from either. Same pinned,
    hash-checked archive the installer uses, cached in .release-cache, so this
    costs one download ever. */
function stageBundledPlugins(): void {
  const destination = join(ROOT, 'third_party', 'plugins');

  for (const { plugin, archive } of fetchBundledPluginArchives('windows-x64')) {
    if (existsSync(join(destination, plugin.bundleName))) continue;

    mkdirSync(destination, { recursive: true });
    console.log(`==> Staging ${plugin.name} ${plugin.version} for the dev build`);
    run('stage plugin', 'tar.exe', ['-xf', archive, '-C', destination]);
  }
}

function installUiDependencies(): void {
  pnpm('Installing UI dependencies', ['install', '--frozen-lockfile'], { cwd: uiDir });
}

/** Copies the built .vst3 bundle where spec-compliant hosts search for a
    user's own plugins — no elevation, no installer. The whole bundle folder is
    replaced, never merged, the same rule the installer applies to ui/. */
function installPluginForHosts(): void {
  const built = join(ROOT, 'build', 'PlectrifyPlugin_artefacts', config, 'VST3', 'Plectrify.vst3');
  if (!existsSync(join(built, 'Contents'))) fail(`plugin bundle not found: ${built}`);

  const destination = join(
    process.env.LOCALAPPDATA ?? fail('LOCALAPPDATA is not set'),
    'Programs', 'Common', 'VST3', 'Plectrify.vst3',
  );

  console.log(`==> Installing ${destination}`);
  try {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(join(destination, '..'), { recursive: true });
    cpSync(built, destination, { recursive: true });
  } catch (error) {
    // stopApp() kills Plectrify.exe and WebView2 orphans, but nothing can
    // release a .vst3 a DAW is holding open.
    fail(
      `could not replace ${destination} — a DAW is probably holding it open. ` +
        `Close the DAW and retry.\n${String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// --ui-only: rebuild the static UI and relaunch, skipping cmake entirely.
// ---------------------------------------------------------------------------
if (values['ui-only']) {
  installUiDependencies();
  pnpm('Building UI (pnpm build)', ['build'], { cwd: uiDir });

  if (!existsSync(exePath(config))) {
    fail(`exe not found: ${exePath(config)}. Run 'pnpm app --dist' once for a full build.`);
  }
  stopApp();
  copyUiBesideExe(config);
  if (!values['no-run']) await startApp(config);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --dist: full build serving the baked ui/dist (UI -> cmake -> tests -> run).
// ---------------------------------------------------------------------------
if (values.dist) {
  const cmake = findCMake();

  if (!values['no-ui']) {
    installUiDependencies();
    pnpm('UI formatting check', ['format:check'], { cwd: uiDir });
    pnpm('svelte-check', ['check'], { cwd: uiDir });
    pnpm('UI tests', ['test'], { cwd: uiDir });
    pnpm('Building UI', ['build'], { cwd: uiDir });
  }

  stageBundledPlugins();
  run('Configuring', cmake, ['-B', join(ROOT, 'build'), '-S', ROOT]);
  stopApp();
  nativeBuild(cmake, 'Plectrify');

  // Every test exe, or ctest silently re-runs a stale binary.
  for (const target of TEST_TARGETS) {
    nativeBuild(cmake, target);
  }
  run('Native tests', findCTest(cmake), [
    '--test-dir', join(ROOT, 'build'), '-C', config, '--output-on-failure',
  ]);

  copyUiBesideExe(config);
  if (!values['no-run']) {
    await startApp(config);
  } else {
    console.log(`Built: ${exePath(config)}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default: hot-reload loop. Vite serves the UI with HMR; the app loads it over
// http so edits appear live inside the real host. WebView2 still injects
// window.__JUCE__, so the native bridge and audio stay wired up.
// ---------------------------------------------------------------------------
// Only Debug builds honour PLECTRIFY_DEV_URL — a Release exe would silently
// serve the baked UI while this script promises hot reload.
if (config !== 'Debug') {
  fail(`the HMR dev loop needs a Debug build. Use 'pnpm app --dist --config ${config}' instead.`);
}

if (!existsSync(join(uiDir, 'node_modules'))) {
  installUiDependencies();
}

let status = await devServerStatus();
if (status === 'foreign') {
  fail(
    "port 5173 is held by something that is not Plectrify's Vite dev server, so the app " +
      `would load the wrong UI (WebView2 shows a bare error page). Stop it and retry.\n${devPortOwner()}`,
  );
}

if (status === 'free') {
  console.log('==> Starting Vite dev server (pnpm dev)');
  const vite = spawn('pnpm', ['dev'], { cwd: uiDir, detached: true, stdio: 'ignore', shell: true });
  vite.unref();

  for (let i = 0; i < 30 && status !== 'vite'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    status = await devServerStatus();
  }
  if (status !== 'vite') fail('Plectrify Vite dev server did not come up on http://localhost:5173');
} else {
  console.log('==> Plectrify Vite dev server already running on :5173');
}

stageBundledPlugins();

const cmake = findCMake();
run('Configuring', cmake, ['-B', join(ROOT, 'build'), '-S', ROOT]);

// ---------------------------------------------------------------------------
// --plugin: the same loop, hosted by a DAW instead of our own exe. The DAW is
// the process to (re)start, so nothing is launched from here — and it is also
// the process holding the installed bundle, which is why the copy step is
// where a stale DAW shows up (see installPluginForHosts).
// ---------------------------------------------------------------------------
if (values.plugin) {
  nativeBuild(cmake, 'PlectrifyPlugin_VST3');
  installPluginForHosts();
  console.log(`
==> Debug Plectrify.vst3 installed for this user's DAWs.
    The Vite dev server is running on http://localhost:5173. For live HMR the
    DAW must inherit PLECTRIFY_DEV_URL — e.g. from PowerShell:

      $env:PLECTRIFY_DEV_URL = 'http://localhost:5173'; & 'C:\\path\\to\\your\\DAW.exe'

    Launched plainly, the plugin serves the last-built ui/dist instead.`);
  process.exit(0);
}

stopApp();
nativeBuild(cmake, 'Plectrify');

if (!values['no-run']) {
  await startApp(config, { PLECTRIFY_DEV_URL: 'http://localhost:5173' }, ' (UI from http://localhost:5173, HMR live)');
} else {
  console.log(`Built: ${exePath(config)} (dev-server mode)`);
}
