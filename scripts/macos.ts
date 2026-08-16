/**
 * macOS plumbing for run.macos.ts and release.macos.ts: where the build
 * lives, how the app is stopped, started and staged. The platform-neutral
 * spawn helpers live in shared.ts, the Windows counterparts in windows.ts —
 * which own Windows-specific hazards (MSBuild .tlog staleness, the WebView2
 * profile lock) that simply do not exist here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, capture, fail, run } from './shared.ts';

export function assertMacos(script: string): void {
  if (process.platform !== 'darwin') {
    fail(`${script} is the macOS path. On Windows use the -windows counterpart.`);
  }
}

/** One build tree per configuration: Ninja and Makefiles are single-config,
    so Debug and Release cannot share one the way the VS generator does. */
export function buildDir(config: string): string {
  return join(ROOT, `build-macos-${config.toLowerCase()}`);
}

export function appPath(config: string): string {
  return join(buildDir(config), 'Plectrify_artefacts', config, 'Plectrify.app');
}

export function appBinary(config: string): string {
  return join(appPath(config), 'Contents/MacOS/Plectrify');
}

export function configure(config: string): void {
  const generator = capture('which', ['ninja']).trim() !== '' ? ['-G', 'Ninja'] : [];
  run(`Configuring (${config})`, 'cmake', [
    '-B', buildDir(config),
    '-S', ROOT,
    `-DCMAKE_BUILD_TYPE=${config}`,
    ...generator,
  ]);
}

export function buildTarget(config: string, target: string, cleanFirst = false): void {
  run(`Building ${target} (${config})`, 'cmake', [
    '--build', buildDir(config),
    '--target', target,
    ...(cleanFirst ? ['--clean-first'] : []),
  ]);
}

/** Ask any running instance to die and wait until it is gone, so the linker
    can overwrite the binary and a relaunch never races the outgoing process.
    (No WebView2-orphan hunt here: WKWebView runs in OS-managed helper
    processes with no per-profile lock to leak.) */
export async function stopApp(): Promise<void> {
  spawnSync('pkill', ['-x', 'Plectrify']);
  for (let i = 0; i < 100; i++) {
    if (spawnSync('pgrep', ['-x', 'Plectrify']).status !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('a Plectrify process is still running and would not exit. Quit it and retry.');
}

/** Launch the app and confirm it is still alive a moment later. A startup
    crash otherwise leaves the script printing "Launching..." and exiting 0
    while nothing is on screen. The binary is exec'd directly rather than via
    `open` so environment variables (PLECTRIFY_DEV_URL) reach it. */
export async function startApp(
  config: string,
  extraEnv: Record<string, string> = {},
  note = '',
): Promise<void> {
  const binary = appBinary(config);
  console.log(`==> Launching ${binary}${note}`);

  const child = spawn(binary, [], {
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);

  if (exited) {
    const hint = await latestCrashReport();
    fail(
      'Plectrify exited immediately after launch.' +
        (hint ? `\nNewest crash report: ${hint}` : '\nCheck ~/Library/Logs/DiagnosticReports.'),
    );
  }
}

/** The newest Plectrify crash report, where macOS files what the Windows
    Event Log holds. */
async function latestCrashReport(): Promise<string> {
  const dir = join(homedir(), 'Library/Logs/DiagnosticReports');
  try {
    const reports = (await readdir(dir)).filter((name) => name.startsWith('Plectrify'));
    const newest = reports.sort().at(-1);
    return newest ? join(dir, newest) : '';
  } catch {
    return '';
  }
}

/** Stage ui/dist into the bundle. Release binaries carry no source-tree
    fallback, and the staged tree lives in Contents/Resources — inside the
    codesign seal, so release.macos.ts must stage BEFORE signing. Debug builds
    serve the source tree's ui/dist directly and need no copy. */
export function stageUiIntoBundle(config: string): void {
  if (config === 'Debug') return;

  const dist = join(ROOT, 'ui/dist');
  if (!existsSync(join(dist, 'index.html'))) {
    fail('ui/dist is missing — build the UI first (rerun without --no-ui).');
  }

  const target = join(appPath(config), 'Contents/Resources/ui');
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true });
}
