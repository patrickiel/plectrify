/**
 * Build the Svelte UI + the native app, then launch it — the macOS counterpart
 * of run.windows.ts (which stays the Windows entry point). Run from the repo root:
 *
 *   pnpm install                once, for tsx
 *   pnpm app                    Default HMR loop: start the Vite dev server +
 *                               launch the app pointed at http://localhost:5173.
 *                               Edit a .svelte file and it hot-reloads live
 *                               inside the real host. (Debug; real audio.)
 *   pnpm app --ui-only          Fast path: rebuild ui/dist + relaunch the app,
 *                               skipping cmake. Serves the baked UI.
 *   pnpm app --dist             Full build + gate: UI (format + check + test +
 *                               build), native (cmake), native tests (ctest),
 *                               then run serving the baked ui/dist.
 *   pnpm app --dist --no-ui     Full build, skip the UI build.
 *   pnpm app --dist --no-run    Full build only, don't launch.
 *   pnpm app --clean            Rebuild the native target from scratch.
 *   pnpm app --dist --config Release
 *                               Release build; stages ui/dist into the bundle
 *                               at Contents/Resources/ui.
 *
 * Deliberately absent relative to run.windows.ts: the .build-unfinished marker (an
 * MSBuild .tlog-staleness hazard Ninja does not have) and the WebView2 orphan
 * hunt (WKWebView holds no per-profile lock).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ROOT,
  TEST_TARGETS,
  capture,
  devServerStatus,
  fail,
  fetchBundledPluginArchives,
  pnpm,
  run,
} from './shared.ts';
import {
  appBinary,
  assertMacos,
  buildTarget,
  configure,
  stageUiIntoBundle,
  startApp,
  stopApp,
} from './macos.ts';

assertMacos('run.macos.ts');

const { values } = parseArgs({
  options: {
    dist: { type: 'boolean', default: false },
    'ui-only': { type: 'boolean', default: false },
    'no-ui': { type: 'boolean', default: false },
    'no-run': { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false },
    config: { type: 'string', default: 'Debug' },
  },
});

const config = values.config!;
const uiDir = join(ROOT, 'ui');

/** Locked, reproducible UI install. Rewriting the lockfile must be an explicit
    action (it would later trip the release scripts' clean-tree gate), never a
    build side effect. */
function installUiDependencies(): void {
  pnpm('Installing UI dependencies', ['install', '--frozen-lockfile'], { cwd: uiDir });
}

/** Put the plugins Plectrify *ships* where a Debug build looks for them
    (third_party/plugins, wired as PLECTRIFY_BUNDLED_PLUGIN_DIR in CMakeLists) —
    the mac twin of run.windows.ts's staging.

    A release stages these into Contents/Resources/plugins; a dev tree has no
    installation, so without this the dev loop runs an app that is missing a
    plugin it assumes is present — and since Neural Amp Modeler left the
    catalogue, there is no panel to install it from either. Same pinned,
    hash-checked archive the release script uses, cached in .release-cache, so
    this costs one download ever.

    ditto rather than `unzip`, for the same reason release.macos.ts uses it: a
    mac VST3's Mach-O has to stay executable and a framework's Versions/Current
    has to stay a link, or the bundle extracts fine and refuses to load. */
function stageBundledPlugins(): void {
  const destination = join(ROOT, 'third_party', 'plugins');

  for (const { plugin, archive } of fetchBundledPluginArchives('macos-arm64')) {
    if (existsSync(join(destination, plugin.bundleName))) continue;

    mkdirSync(destination, { recursive: true });
    console.log(`==> Staging ${plugin.name} ${plugin.version} for the dev build`);
    run('stage plugin', 'ditto', ['-x', '-k', archive, destination]);

    if (!existsSync(join(destination, plugin.bundleName)))
      fail(`${plugin.name}'s archive did not contain ${plugin.bundleName}.`);
  }
}

/** Name the squatter on 5173 — guesswork costs the reader the diagnosis. */
function devPortOwner(): string {
  const owner = capture('lsof', ['-nP', '-iTCP:5173', '-sTCP:LISTEN']).trim();
  return owner === '' ? 'unknown process' : owner;
}

// ---------------------------------------------------------------------------
// --ui-only: rebuild the static UI and relaunch, skipping cmake entirely.
// ---------------------------------------------------------------------------
if (values['ui-only']) {
  installUiDependencies();
  pnpm('Building UI (pnpm build)', ['build'], { cwd: uiDir });

  if (!existsSync(appBinary(config))) {
    fail(`app not found: ${appBinary(config)}. Run 'pnpm app --dist' once for a full build.`);
  }
  await stopApp();
  stageUiIntoBundle(config);
  if (!values['no-run']) await startApp(config);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --dist: full build serving the baked ui/dist (UI -> cmake -> tests -> run).
// ---------------------------------------------------------------------------
if (values.dist) {
  if (!values['no-ui']) {
    installUiDependencies();
    pnpm('UI formatting check', ['format:check'], { cwd: uiDir });
    pnpm('svelte-check', ['check'], { cwd: uiDir });
    pnpm('UI tests', ['test'], { cwd: uiDir });
    pnpm('Building UI', ['build'], { cwd: uiDir });
  }

  stageBundledPlugins();
  configure(config);
  await stopApp();
  buildTarget(config, 'Plectrify', values.clean);

  // Every test target, or ctest re-runs whatever stale binaries exist.
  for (const target of TEST_TARGETS) {
    buildTarget(config, target);
  }
  run('Native tests', 'ctest', ['--test-dir', `build-macos-${config.toLowerCase()}`, '--output-on-failure']);

  stageUiIntoBundle(config);
  if (!values['no-run']) {
    await startApp(config);
  } else {
    console.log(`Built: ${appBinary(config)}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default: hot-reload loop. Vite serves the UI with HMR; the app loads it over
// http so edits appear live inside the real host. The WKWebView still injects
// window.__JUCE__, so the native bridge and audio stay wired up.
// ---------------------------------------------------------------------------
// Only Debug builds honour PLECTRIFY_DEV_URL — a Release app would silently
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
    'port 5173 is held by something that is not Plectrify\'s Vite dev server, so the app ' +
      `would load the wrong UI. Stop it and retry.\n${devPortOwner()}`,
  );
}

if (status === 'free') {
  console.log('==> Starting Vite dev server (pnpm dev)');
  const { spawn } = await import('node:child_process');
  const vite = spawn('pnpm', ['dev'], { cwd: uiDir, detached: true, stdio: 'ignore' });
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

configure(config);
await stopApp();
buildTarget(config, 'Plectrify', values.clean);

if (!values['no-run']) {
  await startApp(config, { PLECTRIFY_DEV_URL: 'http://localhost:5173' }, ' (UI from http://localhost:5173, HMR live)');
} else {
  console.log(`Built: ${appBinary(config)} (dev-server mode)`);
}
