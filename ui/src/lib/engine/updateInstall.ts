/**
 * Installing a newer Plectrify from inside the app.
 *
 * The engine does all of it — fetches the release manifest, downloads the
 * installer, verifies it, runs it silently and quits once the installer is
 * past the UAC prompt, after which the installer relaunches the new version —
 * and reports on one `updateInstallState` stream. This module is the page's
 * half: the shape of that stream, the reducer over it, and the wording, which
 * lives here rather than in C++ for the same reason `describeBackupError` does.
 *
 * Deliberately not a request/response pair. A download runs for a minute or
 * more, far past the bridge's 15 s deadline, so this copies the shape
 * `installPackages` and `backupState` use: fire the intent, then read a stream
 * of state.
 *
 * Windows standalone only (HostCapabilities.selfUpdate); everywhere else the
 * notice keeps its browser "Download" button.
 */

/** Where the run has got to.
 *
 * `launching` is the installer started and the UAC prompt possibly on screen;
 * `installing` is the prompt accepted — the app is about to quit and will not
 * be back until the installer relaunches it. `failed` covers a declined prompt
 * too, though a declined prompt comes back as `idle`: it is the user saying
 * "not now", which is the offer they started from, not an error. */
export type UpdateInstallPhase =
  'idle' | 'downloading' | 'verifying' | 'launching' | 'installing' | 'failed';

export interface UpdateInstallState {
  phase: UpdateInstallPhase;
  /** The version being installed, once the manifest has been read; empty
      before that and on the idle state. */
  version: string;
  receivedBytes: number;
  /** Zero while the size is not known yet. */
  totalBytes: number;
  /** A short token from the engine on `failed`; run it through
      describeUpdateInstallError. */
  error?: string;
}

export const IDLE_UPDATE_INSTALL: UpdateInstallState = {
  phase: 'idle',
  version: '',
  receivedBytes: 0,
  totalBytes: 0,
};

const PHASES: UpdateInstallPhase[] = [
  'idle',
  'downloading',
  'verifying',
  'launching',
  'installing',
  'failed',
];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Folds one engine push into the page's state.
 *
 * Total over whatever arrives: the stream crosses the bridge as loose JSON, and
 * a push with an unreadable phase must leave the state as it was rather than
 * blanking a download in flight. */
export function reduceUpdateInstallState(
  previous: UpdateInstallState,
  event: unknown,
): UpdateInstallState {
  const raw = (event ?? {}) as Record<string, unknown>;
  const phase = str(raw.phase) as UpdateInstallPhase;
  if (!PHASES.includes(phase)) return previous;

  return {
    phase,
    version: str(raw.version),
    receivedBytes: num(raw.receivedBytes),
    totalBytes: num(raw.totalBytes),
    error: str(raw.error) || undefined,
  };
}

/** True while a run is in flight — the notice must stay on screen and offer
    nothing but Cancel, whatever the dismissal says. */
export function isUpdateInstallBusy(state: UpdateInstallState): boolean {
  return state.phase !== 'idle' && state.phase !== 'failed';
}

/** What the notice says under its progress bar. */
export function describeUpdateInstallPhase(state: UpdateInstallState): string {
  switch (state.phase) {
    case 'downloading':
      return state.totalBytes > 0
        ? `Downloading ${formatDownloadProgress(state.receivedBytes, state.totalBytes)}…`
        : 'Downloading…';
    case 'verifying':
      return 'Verifying the download…';
    case 'launching':
      return 'Waiting for Windows to allow the installer…';
    case 'installing':
      return 'Installing… Plectrify will close and reopen in a moment.';
    default:
      return '';
  }
}

/** "12 of 37 MB" — whole megabytes, since the installer is tens of them and a
    decimal would just flicker. */
export function formatDownloadProgress(receivedBytes: number, totalBytes: number): string {
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `${mb(Math.min(receivedBytes, totalBytes))} of ${mb(totalBytes)} MB`;
}

/** Human-readable reason for a failed run. The engine sends short tokens so
    the wording lives here, next to the rest of the notice's copy. Every one
    of them leaves the browser download as the way forward, so none says
    "give up". */
export function describeUpdateInstallError(error: string | undefined): string {
  switch (error) {
    case 'pluginInUse':
      return 'A Plectrify plugin is open in another app, which holds the files the update replaces. Close that app, then try again.';
    case 'busy':
      return 'A package is still installing. Let it finish, then try again.';
    case 'network':
      return "Couldn't reach GitHub to download the update. Check your connection.";
    case 'manifest':
      return "Couldn't read the release's details, so nothing was downloaded.";
    case 'notNewer':
      return 'The newest release is not newer than this one, so there is nothing to install.';
    case 'disk':
      return "Couldn't save the installer. Check there is room on the disk.";
    case 'tooLarge':
      return 'The download was much larger than an installer should be, so it was refused.';
    case 'truncated':
      return 'The download ended early. Try again.';
    case 'checksum':
      return "The download didn't match the release's checksum, so it was discarded.";
    case 'launch':
      return "Couldn't start the installer. If Plectrify has closed, reopen it from the Start menu.";
    case 'unsupported':
      return 'Installing from inside the app is only available on Windows.';
    default:
      return error || 'Something went wrong.';
  }
}
