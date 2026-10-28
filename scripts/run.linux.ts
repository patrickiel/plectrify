/**
 * Build the Svelte UI + the native app, then launch it — the Linux twin of
 * run.macos.ts, with the same modes. Run from the repo root:
 *
 *   pnpm install                once, for tsx
 *   pnpm app                    Default HMR loop: start the Vite dev server +
 *                               launch the Debug app pointed at it.
 *   pnpm app --ui-only          Rebuild ui/dist + relaunch, skipping cmake.
 *   pnpm app --dist             Full build + gate: UI (format + check + test +
 *                               build), native (cmake), native tests (ctest),
 *                               then run serving the baked ui/dist.
 *   pnpm app --dist --no-ui     Full build, skip the UI build.
 *   pnpm app --dist --no-run    Full build only, don't launch.
 *   pnpm app --clean            Rebuild the native target from scratch.
 *   pnpm app --dist --config Release
 *                               Release build; stages ui/ beside the binary.
 *   pnpm app --plugin           Build the Debug VST3 instead of the app and
 *                               install it into ~/.vst3 for this user's DAWs.
 *                               Starts Vite like the default loop; launch the
 *                               DAW with PLECTRIFY_DEV_URL set for live HMR.
 *
 * Needs the system libraries JUCE builds against on Linux; configure() names
 * the exact `apt install` line when any are missing.
 */
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ROOT,
  TEST_TARGETS,
  bundledPluginsMissingFor,
  capture,
  devServerStatus,
  fail,
  fetchBundledPluginArchives,
  pnpm,
  run,
} from './shared.ts';
import { DEV_SERVER_PORT, DEV_SERVER_URL } from './devServer.ts';
import {
  IN_TREE_PLUGINS,
  appBinary,
  assertLinux,
  buildDir,
  buildTarget,
  checkContentRoot,
  configure,
  inTreePluginBundle,
  pluginBundle,
  stageUiBesideBinary,
  startApp,
  stopApp,
} from './linux.ts';

assertLinux('run.linux.ts');

const PLATFORM = 'linux-x64';

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
  fail('--plugin is the Debug dev loop only; a Release .vst3 is staged by the release pipeline (pnpm release).');
}

/** Copies the built bundle into ~/.vst3, beside the catalogue installer's
    plugins, where every Linux VST3 host looks. Replaced whole, never merged. */
function installPluginForHosts(): void {
  const built = pluginBundle(config);
  if (!existsSync(join(built, 'Contents'))) fail(`plugin bundle not found: ${built}`);

  const destination = join(homedir(), '.vst3', 'Plectrify.vst3');
  console.log(`==> Installing ${destination}`);
  mkdirSync(join(destination, '..'), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(built, destination, { recursive: true, verbatimSymlinks: true });
}

function installUiDependencies(): void {
  pnpm('Installing UI dependencies', ['install', '--frozen-lockfile'], { cwd: uiDir });
}

/** Put the plugins Plectrify ships where a Debug build looks for them
    (third_party/plugins). The ones Linux builds in-tree are built and copied
    (always, so the dev build never runs a stale one); the rest come from their
    pinned archives. A shipped plugin with neither is reported and skipped: the
    dev loop still runs, it just lacks what that plugin enables. Needs the tree
    configured. */
function stageBundledPlugins(): void {
  const destination = join(ROOT, 'third_party', 'plugins');

  for (const { target, bundle } of Object.values(IN_TREE_PLUGINS)) {
    buildTarget(config, target);
    const staged = join(destination, bundle);
    mkdirSync(destination, { recursive: true });
    rmSync(staged, { recursive: true, force: true });
    cpSync(inTreePluginBundle(config, bundle), staged, { recursive: true, verbatimSymlinks: true });
  }

  const missing = bundledPluginsMissingFor(PLATFORM).filter((p) => !(p.id in IN_TREE_PLUGINS));
  for (const plugin of missing) {
    console.warn(
      `warning: ${plugin.name} has no ${PLATFORM} build in packaging/bundled-plugins.json; ` +
        'the dev build runs without it.',
    );
  }
  const skip = [...Object.keys(IN_TREE_PLUGINS), ...missing.map((p) => p.id)];
  for (const { plugin, archive } of fetchBundledPluginArchives(PLATFORM, skip)) {
    if (existsSync(join(destination, plugin.bundleName))) continue;

    mkdirSync(destination, { recursive: true });
    console.log(`==> Staging ${plugin.name} ${plugin.version} for the dev build`);
    // unzip keeps the mode bits the reproducible archiver records, so the
    // shared object stays loadable.
    run('stage plugin', 'unzip', ['-q', '-o', archive, '-d', destination]);

    if (!existsSync(join(destination, plugin.bundleName)))
      fail(`${plugin.name}'s archive did not contain ${plugin.bundleName}.`);
  }
}

function devPortOwner(): string {
  const owner = capture('ss', ['-ltnp', `sport = :${DEV_SERVER_PORT}`]).trim();
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
  stageUiBesideBinary(config);
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

  configure(config);
  stageBundledPlugins();
  checkContentRoot();
  await stopApp();
  buildTarget(config, 'Plectrify', values.clean);

  // Every test target, or ctest re-runs whatever stale binaries exist.
  for (const target of TEST_TARGETS) {
    buildTarget(config, target);
  }
  run('Native tests', 'ctest', ['--test-dir', buildDir(config), '--output-on-failure']);

  stageUiBesideBinary(config);
  if (!values['no-run']) {
    await startApp(config);
  } else {
    console.log(`Built: ${appBinary(config)}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default: hot-reload loop. Vite serves the UI with HMR; the Debug app loads
// it over http with the native bridge still injected.
// ---------------------------------------------------------------------------
if (config !== 'Debug') {
  fail(`the HMR dev loop needs a Debug build. Use 'pnpm app --dist --config ${config}' instead.`);
}

if (!existsSync(join(uiDir, 'node_modules'))) {
  installUiDependencies();
}

let status = await devServerStatus();
if (status === 'foreign') {
  fail(
    `port ${DEV_SERVER_PORT} is held by something that is not Plectrify's Vite dev server, so ` +
      `the app would load the wrong UI. Stop it and retry.\n${devPortOwner()}`,
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
  if (status !== 'vite') fail(`Plectrify Vite dev server did not come up on ${DEV_SERVER_URL}`);
} else {
  console.log(`==> Plectrify Vite dev server already running on :${DEV_SERVER_PORT}`);
}

configure(config);
stageBundledPlugins();
checkContentRoot();

if (values.plugin) {
  buildTarget(config, 'PlectrifyPlugin_VST3', values.clean);
  installPluginForHosts();
  console.log(`
==> Debug Plectrify.vst3 installed into ~/.vst3 for this user's DAWs.
    The Vite dev server is running on ${DEV_SERVER_URL}. For live HMR the
    DAW must inherit PLECTRIFY_DEV_URL — e.g.:

      PLECTRIFY_DEV_URL=${DEV_SERVER_URL} reaper

    Launched plainly, the plugin serves the last-built ui/dist instead.`);
  process.exit(0);
}

await stopApp();
buildTarget(config, 'Plectrify', values.clean);

if (!values['no-run']) {
  await startApp(config, { PLECTRIFY_DEV_URL: DEV_SERVER_URL }, ` (UI from ${DEV_SERVER_URL}, HMR live)`);
} else {
  console.log(`Built: ${appBinary(config)} (dev-server mode)`);
}
