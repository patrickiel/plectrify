import type { AppSettings } from './types';

/** What the person installing Plectrify chose about the two things the app
    does on the network without being asked: the launch's update check and the
    first run's starter-plugin download. The Windows installer offers both as
    checkboxes and writes the answer to `<content root>/installer-options.json`,
    which the engine bakes into the page at boot (`installerDefaults`).

    Each key is optional — absent means the installer did not ask, which is
    every installer before this one, the macOS pkg, the .deb and every dev
    build — and absent changes nothing. */
export interface InstallerDefaults {
  checkForUpdates?: boolean;
  starterInstall?: boolean;
}

/** Validate whatever the engine handed over. Anything that is not an object of
    booleans contributes nothing rather than failing: the file is outside the
    page's control, and the worst a bad one may do is leave the defaults alone. */
export function parseInstallerDefaults(raw: unknown): InstallerDefaults {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const seen = value as Record<string, unknown>;
  const out: InstallerDefaults = {};
  if (typeof seen.checkForUpdates === 'boolean') out.checkForUpdates = seen.checkForUpdates;
  if (typeof seen.starterInstall === 'boolean') out.starterInstall = seen.starterInstall;
  return out;
}

/** Lay the installer's choices under the user's own settings.

    `stored` is what settings.json held (null when there is none), and only a
    question it leaves unanswered is the installer's to answer — a setting the
    user changed in the app always wins, including over a later reinstall.

    - The update check: taken from the installer whenever settings.json has no
      `checkForUpdates`, which also covers an existing user upgrading through
      an installer that asked.
    - The starter install: only on a machine with no settings.json at all,
      since that is the only machine still owed one (see starterBundle.ts).
      Declining marks it attempted, which is exactly "never". */
export function applyInstallerDefaults(
  settings: AppSettings,
  stored: unknown,
  defaults: InstallerDefaults,
): AppSettings {
  const storedObject =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : null;
  let next = settings;
  if (
    defaults.checkForUpdates !== undefined &&
    typeof storedObject?.checkForUpdates !== 'boolean'
  ) {
    next = { ...next, checkForUpdates: defaults.checkForUpdates };
  }
  if (defaults.starterInstall === false && storedObject === null) {
    next = { ...next, starterInstallAttempted: true };
  }
  return next;
}

/** What settings.json should hold for `settings`, given the document they were
    built from (`source`: what was on disk with this write's changes over it).

    `checkForUpdates` is written only once that document answers it — the user
    flipped it in Settings, now or earlier. Otherwise the value in `settings`
    is the installer's (or the plain default), and storing it would turn it
    into "the user's own choice" on the first write of any unrelated setting:
    a later reinstall with the box unticked would then be ignored for good,
    which is the installer's off switch not working. Left out, the question
    stays the installer's to answer on every launch. */
export function settingsToStore(settings: AppSettings, source: unknown): Partial<AppSettings> {
  const answered =
    typeof source === 'object' &&
    source !== null &&
    typeof (source as Record<string, unknown>).checkForUpdates === 'boolean';
  if (answered) return settings;
  const stored: Partial<AppSettings> = { ...settings };
  delete stored.checkForUpdates;
  return stored;
}
