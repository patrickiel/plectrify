/**
 * Windows plumbing for run.windows.ts and release.windows.ts: VS-bundled tool
 * discovery, stopping the app (including its WebView2 orphans), launching it
 * with a crash diagnosis, and the MSBuild interrupted-build marker.
 *
 * PowerShell survives here as a *utility*, not the orchestrator: WMI process
 * command lines, the Event Log, Authenticode verification and elevation have
 * no plain-CLI equivalents worth hand-rolling, so those four queries shell out
 * to one-line `powershell -Command` calls. Everything else is Node.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, capture, fail } from './shared.ts';

export function assertWindows(script: string): void {
  if (process.platform !== 'win32') {
    fail(`${script} is the Windows path. On macOS use the -macos counterpart.`);
  }
}

/** One quoted PowerShell invocation. The script string is always a literal
    written in this repo — never interpolate untrusted input into it. */
export function powershell(script: string): { ok: boolean; output: string } {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Locate CMake: prefer PATH, else the Visual Studio-bundled copy. The VS
    layout is <root>\<year>\<edition>\Common7\...\CMake\bin\cmake.exe, so two
    directory levels plus a fixed suffix cover every install without the
    minutes-long recursive sweep the .ps1 used. */
export function findCMake(): string {
  const onPath = capture('where', ['cmake']).split(/\r?\n/)[0]?.trim();
  if (onPath && existsSync(onPath)) return onPath;

  const vsRoot = 'C:\\Program Files\\Microsoft Visual Studio';
  const suffix = 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe';
  for (const year of safeReaddir(vsRoot)) {
    for (const edition of safeReaddir(join(vsRoot, year))) {
      const candidate = join(vsRoot, year, edition, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  fail('CMake was not found. Install the Visual Studio C++ workload or add CMake to PATH.');
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** ctest ships beside the VS-bundled cmake; fall back to PATH. */
export function findCTest(cmakePath: string): string {
  const beside = join(dirname(cmakePath), 'ctest.exe');
  if (existsSync(beside)) return beside;
  const onPath = capture('where', ['ctest']).split(/\r?\n/)[0]?.trim();
  if (onPath && existsSync(onPath)) return onPath;
  fail('ctest was not found alongside CMake or on PATH.');
}

export function exePath(config: string): string {
  return join(ROOT, 'build', 'Plectrify_artefacts', config, 'Plectrify.exe');
}

/**
 * Stop a running instance so the linker (or a relaunch) can overwrite/reuse
 * the exe, and wait until it is gone.
 *
 * A killed (or crashed) Plectrify also leaves its msedgewebview2.exe children
 * behind, and those keep holding the per-profile WebView2 user-data lock
 * (%APPDATA%/Plectrify/WebView2). Clear them too, or the next run builds fine,
 * launches, and dies on startup with nothing in the log. The command-line
 * filter needs WMI, hence the PowerShell hop.
 */
export function stopApp(): void {
  powershell(
    "Get-Process -Name Plectrify -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " +
      "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.CommandLine -like '*\\Plectrify\\WebView2*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  );

  for (let i = 0; i < 100; i++) {
    if (spawnSync('tasklist', ['/FI', 'IMAGENAME eq Plectrify.exe', '/NH'], { encoding: 'utf8' })
      .stdout?.includes('Plectrify.exe') !== true) {
      return;
    }
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 100']);
  }
  fail('a Plectrify process is still running and would not exit. Close it and retry.');
}

/** Start the app and confirm it is still alive a moment later. A startup
    crash (WebView2 profile still locked, a bad plugin scan cache, a
    half-written ui/dist) otherwise leaves the script printing "Launching..."
    and exiting 0 while nothing is on screen. */
export async function startApp(
  config: string,
  extraEnv: Record<string, string> = {},
  note = '',
): Promise<void> {
  const exe = exePath(config);
  console.log(`==> Launching ${exe}${note}`);

  const child = spawn(exe, [], {
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
    // The Event Log holds what the process itself could not say.
    const crash = powershell(
      "Get-WinEvent -FilterHashtable @{ LogName='Application'; ProviderName='Application Error' } -MaxEvents 5 -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.Message -like '*Plectrify.exe*' -and $_.TimeCreated -gt (Get-Date).AddMinutes(-2) } | " +
        'Select-Object -First 1 -ExpandProperty Message',
    ).output.split(/\r?\n/).slice(0, 3).join('\n').trim();
    fail(`Plectrify exited immediately after launch.${crash ? `\n${crash}` : ''}`);
  }
}

/** Name whatever holds the Vite dev port — guesswork here costs the reader
    the whole diagnosis. */
export function devPortOwner(): string {
  const owner = powershell(
    '$c = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
      'if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue; ' +
      'if ($p) { "pid $($c.OwningProcess) ($($p.Name)): $($p.CommandLine)" } else { "pid $($c.OwningProcess)" } }',
  ).output.trim();
  return owner === '' ? 'unknown process' : owner;
}

/**
 * The interrupted-build marker. A native build is not atomic: MSBuild records
 * what it compiled in .tlog files as it goes, so interrupting one — Ctrl+C,
 * closing the terminal, a crash, a reboot — can leave that record claiming an
 * object is current when it was in fact compiled against an older header. The
 * next build skips it, the link succeeds, and the exe corrupts its own heap at
 * startup with random-looking crash addresses. So the build is marked as in
 * flight and the mark cleared only on success; a leftover mark means the last
 * build never finished, and the one safe response is a clean rebuild.
 * (Ninja does not have this failure mode, which is why run.macos.ts has no
 * counterpart.)
 */
export const BUILD_MARKER = join(ROOT, 'build', '.build-unfinished');

export function markerDemandsClean(): boolean {
  return existsSync(BUILD_MARKER);
}

export function setBuildMarker(): void {
  writeFileSync(BUILD_MARKER, '');
}

export function clearBuildMarker(): void {
  rmSync(BUILD_MARKER, { force: true });
}

/** Release binaries carry no source-tree fallback for the UI: stage ui/dist
    beside the exe, exactly like the installer lays it out. Debug serves the
    source tree's ui/dist directly and needs no copy. */
export function copyUiBesideExe(config: string): void {
  if (config === 'Debug') return;
  const dist = join(ROOT, 'ui', 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    fail('ui/dist is missing — build the UI first (rerun without --no-ui).');
  }
  const target = join(dirname(exePath(config)), 'ui');
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true });
}
