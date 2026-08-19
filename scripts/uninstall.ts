/**
 * `pnpm purge` — remove every Plectrify installation and every trace it left
 * behind, on Windows and macOS from one script.
 *
 * One file rather than a windows/macos pair, unlike run.ts and release.ts:
 * those dispatch because building is genuinely two different jobs, while this
 * is a single list of paths that happens to read differently per OS. The two
 * halves share the whole of their structure — enumerate, report, delete,
 * report what could not be deleted — and differ in nothing but the paths.
 *
 * Nothing is deleted without --yes. The default run prints exactly what it
 * would remove and exits, because that list includes the user's rigs, patches
 * and downloaded TONE3000 tones, and there is no undo.
 *
 *   pnpm purge                    List what a purge would remove; delete nothing
 *   pnpm purge --yes              Do it
 *   pnpm purge --yes --keep-user-data
 *                                 Keep rigs, patches, settings, TONE3000 account
 *   pnpm purge --yes --keep-packages
 *                                 Keep plugins and content installed from the
 *                                 Packages panel (the app's own uninstaller
 *                                 leaves these alone too — they are the user's)
 *
 * Elevation. The machine-wide targets — Program Files, the shared VST3 folder
 * and ProgramData on Windows; /Applications and /Library/Audio/Plug-Ins on
 * macOS — were written by an installer that asked for admin rights, so removing
 * them needs the same. Windows refuses up front and asks to be re-run from an
 * elevated prompt (a running console process cannot elevate itself). macOS
 * shells the individual system removals out to sudo, which prompts.
 *
 * Deliberately left alone: the WebView2 Runtime and the Visual C++
 * redistributable on Windows — shared with every other application, and the
 * installer only ever ensured they were present — and the shared plug-in
 * folders themselves on both OSes, of which only Plectrify's own bundles go.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { capture, fail, probe, run } from './shared.ts';

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', short: 'y', default: false },
    'keep-user-data': { type: 'boolean', default: false },
    'keep-packages': { type: 'boolean', default: false },
  },
});

const windows = process.platform === 'win32';
const macos = process.platform === 'darwin';
if (!windows && !macos) fail('Plectrify runs on Windows and macOS only.');

const dryRun = !values.yes;
const home = homedir();

/** One thing to remove. `elevated` means the path belongs to an installation
    written with admin rights, which is what decides whether this process may
    touch it at all (Windows) or has to ask sudo to (macOS). */
interface Target {
  path: string;
  what: string;
  elevated?: boolean;
}

const targets: Target[] = [];
/** Exit code of a command that owns the terminal while it runs — `probe` in
    shared.ts discards stdio, and sudo has a password to ask for. */
function runInteractive(command: string, args: string[]): number {
  return spawnSync(command, args, { stdio: 'inherit' }).status ?? 1;
}

const add = (path: string | undefined, what: string, elevated = false) => {
  if (path && existsSync(path)) targets.push({ path, what, elevated });
};

// --- Stop anything holding the files ------------------------------------------------------
// A running app, or a DAW with the plugin loaded, keeps its own files open —
// and on Windows an open file is an undeletable one. The app we can close; a
// DAW is the user's to close, so it is named in the failure report rather than
// killed from here.
function stopPlectrify(): void {
  if (windows) {
    if (probe('taskkill', ['/IM', 'Plectrify.exe', '/F', '/T']) === 0) {
      console.log('==> Closed a running Plectrify');
    }
  } else if (probe('pkill', ['-x', 'Plectrify']) === 0) {
    console.log('==> Closed a running Plectrify');
  }
}

// --- Windows: the registered uninstaller ---------------------------------------------------
// Inno Setup registers the uninstaller under the AppId in Plectrify.iss with
// its own `_is1` suffix, in whichever hive the install ran from. Running it is
// what removes the Start-menu entry and the Add/Remove Programs record
// properly; the path sweep below then catches whatever an interrupted or older
// install left behind.
const INNO_SUFFIX = 'Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A7D2B4F0-4DF8-4B27-A8D7-7F6C5F9F1A01}_is1';
const INNO_HIVES = [
  `HKLM\\Software\\${INNO_SUFFIX}`,
  `HKLM\\Software\\WOW6432Node\\${INNO_SUFFIX}`,
  `HKCU\\Software\\${INNO_SUFFIX}`,
];

/** A single REG_SZ value, or ''. `reg query` prints `    Name    REG_SZ    value`
    and an install path contains spaces, so split on the type rather than on
    whitespace. */
function regValue(key: string, name: string): string {
  const line = capture('reg', ['query', key, '/v', name])
    .split(/\r?\n/)
    .find((text) => text.includes('REG_SZ'));
  return line ? line.split('REG_SZ')[1]!.trim() : '';
}

function installedHives(): string[] {
  return windows ? INNO_HIVES.filter((key) => probe('reg', ['query', key]) === 0) : [];
}

/** Run Inno's uninstaller and wait for it to finish. It cannot be waited on
    directly: unins000.exe copies itself into the temp directory, hands over and
    exits at once, so the spawn returns long before the install is gone. That
    copy deletes the original last, which makes the original's disappearance the
    honest completion signal. */
async function runInnoUninstaller(): Promise<void> {
  for (const key of installedHives()) {
    const uninstaller = regValue(key, 'UninstallString').replace(/^"|"$/g, '');
    if (!uninstaller || !existsSync(uninstaller)) continue;

    console.log(`==> Running the registered uninstaller (${key.split('\\')[0]})`);
    run('Uninstall Plectrify', uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);

    for (let waited = 0; waited < 180_000 && existsSync(uninstaller); waited += 500) {
      await sleep(500);
    }
    if (existsSync(uninstaller)) {
      console.warn('warning: the uninstaller is still running after three minutes; removing its files anyway.');
    }
  }
}

/** Whatever the uninstaller did not take with it. Deleting the key is not the
    normal path — it is what clears an Add/Remove Programs entry pointing at an
    install that is no longer there, which is the state an interrupted
    uninstall leaves. */
function removeInnoRegistryKeys(): void {
  for (const key of installedHives()) {
    console.log(`==> Removing ${key}`);
    if (probe('reg', ['delete', key, '/f']) !== 0) console.warn(`warning: could not remove ${key}.`);
  }
}

// --- macOS: installer receipts -------------------------------------------------------------
// The pkg records one receipt per component. Forgetting them removes nothing on
// disk — it is what stops `pkgutil --pkgs` reporting a Plectrify that is no
// longer installed, and what keeps a later reinstall from being treated as an
// upgrade over files this script deleted.
const PKG_RECEIPTS = [
  'io.github.patrickiel.plectrify.pkg.app',
  'io.github.patrickiel.plectrify.pkg.vst3',
  'io.github.patrickiel.plectrify.pkg.au',
];

function presentReceipts(): string[] {
  return macos ? PKG_RECEIPTS.filter((id) => probe('pkgutil', ['--pkg-info', id]) === 0) : [];
}

function forgetReceipts(): void {
  for (const receipt of presentReceipts()) {
    console.log(`==> Forgetting receipt ${receipt}`);
    if (runInteractive('sudo', ['pkgutil', '--forget', receipt]) !== 0) {
      console.warn(`warning: could not forget ${receipt}.`);
    }
  }
}

// --- Packages the user installed from inside the app ---------------------------------------
// On Windows all of these live under %PROGRAMDATA%\Plectrify, a folder of ours,
// so the whole tree goes with the rest of the path sweep. macOS is the awkward
// one: its managed plugin directory is ~/Library/Audio/Plug-Ins/VST3, shared
// with every other VST3 installer on the machine, so the only defensible
// removal is the one the app itself performs — delete exactly the files the
// install markers say Plectrify wrote, and nothing else in that folder.
function macManagedPluginTargets(): Target[] {
  const markerDir = join(home, 'Library', 'Audio', 'Plug-Ins', 'VST3', '.plectrify-installed');
  if (!existsSync(markerDir)) return [];

  const found: Target[] = [];
  for (const marker of readdirSync(markerDir).filter((name) => name.endsWith('.json'))) {
    // A bundle marker records a set of other packages, never files of its own.
    if (marker.startsWith('bundle-')) continue;

    let record: { dir?: unknown; files?: unknown };
    try {
      record = JSON.parse(readFileSync(join(markerDir, marker), 'utf8'));
    } catch {
      console.warn(`warning: ${marker} is not readable JSON; leaving the files it names in place.`);
      continue;
    }

    const dir = typeof record.dir === 'string' ? record.dir : '';
    if (!dir) continue;

    for (const file of Array.isArray(record.files) ? record.files : []) {
      if (typeof file !== 'string') continue;
      const path = join(dir, file);
      if (existsSync(path)) found.push({ path, what: `installed package (${marker.replace(/\.json$/, '')})` });
    }
  }

  found.push({ path: markerDir, what: 'install markers' });
  return found;
}

// --- The list -------------------------------------------------------------------------------
if (windows) {
  const programFiles = process.env['ProgramFiles'];
  const localAppData = process.env['LOCALAPPDATA'];
  const appData = process.env['APPDATA'];
  const programData = process.env['ProgramData'];
  const commonFiles = process.env['CommonProgramFiles'];

  // Where the install actually is, when the registry still knows: an install
  // to a non-default directory is invisible to a fixed path list.
  for (const key of installedHives()) {
    add(regValue(key, 'InstallLocation').replace(/[\\/]+$/, ''), 'application', true);
  }
  add(programFiles && join(programFiles, 'Plectrify'), 'application', true);
  add(localAppData && join(localAppData, 'Programs', 'Plectrify'), 'application (per-user install)');

  // The shipped VST3, and the dev loop's copy of it. Only Plectrify's own
  // bundle: both folders belong to every plugin vendor on the machine.
  add(commonFiles && join(commonFiles, 'VST3', 'Plectrify.vst3'), 'VST3 plug-in', true);
  add(localAppData && join(localAppData, 'Programs', 'Common', 'VST3', 'Plectrify.vst3'), 'VST3 plug-in (dev build)');

  add(programData && join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Plectrify'), 'Start menu entry', true);
  add(appData && join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Plectrify'), 'Start menu entry');

  if (!values['keep-user-data']) {
    // Rigs, patches, settings, the audio device state, the plugin scan cache,
    // the TONE3000 credentials and all three WebView2 browser profiles.
    add(appData && join(appData, 'Plectrify'), 'user data');
  }
  if (!values['keep-packages']) {
    add(programData && join(programData, 'Plectrify'), 'installed packages and content', true);
  }
} else {
  add('/Applications/Plectrify.app', 'application', true);
  add('/Library/Audio/Plug-Ins/VST3/Plectrify.vst3', 'VST3 plug-in', true);
  add('/Library/Audio/Plug-Ins/Components/Plectrify.component', 'AU plug-in', true);

  // The dev loop installs into the per-user folders instead.
  add(join(home, 'Applications', 'Plectrify.app'), 'application (per-user)');
  add(join(home, 'Library', 'Audio', 'Plug-Ins', 'VST3', 'Plectrify.vst3'), 'VST3 plug-in (dev build)');
  add(join(home, 'Library', 'Audio', 'Plug-Ins', 'Components', 'Plectrify.component'), 'AU plug-in (dev build)');

  if (!values['keep-user-data']) {
    add(join(home, 'Library', 'Application Support', 'Plectrify'), 'user data');
    // What the OS keeps against a bundle id, as opposed to what Plectrify
    // wrote: preferences, the window-restore blob, and WKWebView's own storage
    // — for the app and for the plugin, which is a bundle id of its own.
    for (const id of ['io.github.patrickiel.plectrify', 'io.github.patrickiel.plectrify.plugin']) {
      add(join(home, 'Library', 'Preferences', `${id}.plist`), 'preferences');
      add(join(home, 'Library', 'Caches', id), 'cache');
      add(join(home, 'Library', 'WebKit', id), 'web view data');
      add(join(home, 'Library', 'HTTPStorages', id), 'web view storage');
      add(join(home, 'Library', 'HTTPStorages', `${id}.binarycookies`), 'web view cookies');
      add(join(home, 'Library', 'Saved Application State', `${id}.savedState`), 'saved window state');
    }
  }
  if (!values['keep-packages']) {
    targets.push(...macManagedPluginTargets());
    add('/Users/Shared/Plectrify', 'installed content', true);
  }
}

/** Whether this process holds an elevated token, read from the integrity level
    in its own group list (`S-1-16-12288` is High). Deliberately not the usual
    `net session` probe: that answers "access denied" and "the Server service is
    stopped" with the same non-zero status, so a machine with the service off
    would be told to elevate a terminal that already is. */
function elevatedOnWindows(): boolean {
  return capture('whoami', ['/groups']).includes('S-1-16-12288');
}

// --- Report, then act ------------------------------------------------------------------------
const receipts = presentReceipts();
const hives = installedHives();

if (targets.length === 0 && receipts.length === 0 && hives.length === 0) {
  console.log('No Plectrify installation or leftover data found.');
  process.exit(0);
}

console.log(dryRun ? 'Would remove:' : 'Removing:');
for (const { path, what, elevated } of targets) {
  const kind = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : 'file';
  console.log(`  ${path}${elevated ? '  [needs admin]' : ''}\n      ${what} (${kind})`);
}
if (hives.length > 0) console.log('  the Add/Remove Programs entry');
if (receipts.length > 0) console.log(`  the installer receipts (${receipts.join(', ')})`);

if (values['keep-user-data']) console.log('\nKeeping rigs, patches and settings (--keep-user-data).');
if (values['keep-packages']) console.log('Keeping plugins and content installed from the Packages panel (--keep-packages).');

if (dryRun) {
  console.log('\nNothing was deleted. Re-run with --yes to remove all of the above.');
  process.exit(0);
}

// Windows cannot elevate a console process that is already running, so a run
// that would fail halfway is refused before it deletes anything.
if (windows && targets.some(({ elevated }) => elevated) && !elevatedOnWindows()) {
  fail('this purge needs administrator rights. Re-run it from an elevated terminal.');
}

stopPlectrify();
if (windows) await runInnoUninstaller();

const failures: string[] = [];
let denied = false;
for (const { path, what, elevated } of targets) {
  if (!existsSync(path)) continue; // the uninstaller may already have taken it
  console.log(`==> Removing ${path} (${what})`);
  try {
    if (macos && elevated && process.getuid?.() !== 0) {
      // Written as root by the pkg; sudo prompts on the inherited terminal.
      if (runInteractive('sudo', ['rm', '-rf', path]) !== 0) throw new Error('sudo rm failed');
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${path} — ${message}`);
    // A machine-wide path refusing a *permission* is the elevation story, not
    // the open-file one: the folder an installer wrote is unwritable by a
    // standard user however few handles are held on it.
    if (elevated && /EPERM|EACCES/.test(message)) denied = true;
  }
}

if (windows) removeInnoRegistryKeys();
if (macos) forgetReceipts();

if (failures.length > 0) {
  console.error('\nThese could not be removed:');
  for (const line of failures) console.error(`  ${line}`);
  fail(
    denied
      ? windows
        ? 'these belong to a machine-wide installation. Re-run the purge from an elevated terminal.'
        : 'these belong to a machine-wide installation and the removal was not authorised.'
      : 'close any DAW or Explorer window holding these files and re-run.',
  );
}

console.log('\nPlectrify removed.');
console.log(
  windows
    ? 'The WebView2 Runtime and the Visual C++ redistributable were left in place: they are shared with other applications.'
    : "The shared plug-in folders were left in place; only Plectrify's own bundles inside them were removed.",
);
