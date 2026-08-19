/**
 * Backing the user's work up to a file, and putting it back.
 *
 * The engine does all of it — the file dialog, the archive, the replacement —
 * and reports on one `backupState` stream. This module is the page's half:
 * the shape of that stream, the reducer over it, and the wording, which lives
 * here rather than in C++ for the same reason `describeInstallError` does.
 *
 * Deliberately not a request/response pair. A user can sit in a save dialog
 * for minutes, far past the bridge's 15 s deadline, so this copies the shape
 * `installPackages` uses: fire the intent, then read a stream of state.
 */

/** Where an operation has got to.
 *
 * `choosing` covers the file dialog being open, which is the long part and the
 * part nothing on screen can hurry. `cancelled` is a first-class outcome, not
 * a failure: closing a file dialog is an ordinary thing to do and must not
 * leave an error on the panel. */
export type BackupPhase = 'idle' | 'choosing' | 'working' | 'done' | 'failed' | 'cancelled';

/** Which of the two operations a state belongs to. They share a stream because
    only one can ever be in flight — both are gated behind a modal file dialog. */
export type BackupAction = 'backup' | 'restore';

export interface BackupState {
  phase: BackupPhase;
  action: BackupAction;
  /** The archive written or read, as an absolute path. Shown back to the user
      so "Saved" says where; empty until the dialog returns. */
  path: string;
  /** How much the archive turned out to hold. */
  counts: { rigs: number; patches: number };
  /** The platform slug the archive records (`windows-x64`, `macos-arm64`).
      Only interesting on a restore, and only when it is not this machine's. */
  platform: string;
  /** A short token from the engine; run it through describeBackupError. */
  error?: string;
}

/** Nothing has happened yet. Also what a panel resets to when it closes. */
export const IDLE_BACKUP: BackupState = {
  phase: 'idle',
  action: 'backup',
  path: '',
  counts: { rigs: 0, patches: 0 },
  platform: '',
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0);

const PHASES: BackupPhase[] = ['idle', 'choosing', 'working', 'done', 'failed', 'cancelled'];

/** Folds one engine push into the panel's state.
 *
 * Total over whatever arrives: the stream crosses the bridge as loose JSON, and
 * a push with an unreadable phase must leave the panel as it was rather than
 * blanking it. */
export function reduceBackupState(previous: BackupState, event: unknown): BackupState {
  const raw = (event ?? {}) as Record<string, unknown>;
  const phase = str(raw.phase) as BackupPhase;
  if (!PHASES.includes(phase)) return previous;

  const counts = (raw.counts ?? {}) as Record<string, unknown>;
  return {
    phase,
    action: str(raw.action) === 'restore' ? 'restore' : 'backup',
    path: str(raw.path),
    counts: { rigs: num(counts.rigs), patches: num(counts.patches) },
    platform: str(raw.platform),
    error: str(raw.error) || undefined,
  };
}

/** Human-readable reason for a failed operation. The engine sends short tokens
 *  so the wording lives here, next to the rest of the panel's copy. */
export function describeBackupError(error: string | undefined): string {
  switch (error) {
    case 'empty':
      return 'There is nothing to back up yet — save a rig or a patch first.';
    case 'write':
      return "Couldn't write the backup. Check there is room on the disk.";
    case 'save':
      return "Couldn't save the backup to that location. Try another folder.";
    case 'notBackup':
      return 'That file is not a Plectrify backup.';
    case 'newerFormat':
      return 'That backup was written by a newer version of Plectrify. Update, then try again.';
    case 'dataRoot':
      return "Couldn't open the Plectrify data folder, so nothing was changed.";
    case 'damaged':
      return 'The backup could not be unpacked; it may be damaged.';
    default:
      return error || 'Something went wrong.';
  }
}

/** Just the file name out of an absolute path, for the "Saved to" line.
 *
 * The Settings panel is 18rem wide and a real path is far wider than that, so
 * the whole thing would wrap to four lines and leave the card a different
 * height than it started. The name is the part that identifies the backup; the
 * full path goes in the row's tooltip, where it costs no space. Splits on both
 * separators rather than the platform's, since the string is whatever the OS
 * file dialog handed back. */
export function backupFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** What the Backup card's status line says a restore did.
 *
 * `thisPlatform` is the running build's slug (AppInfo.platform maps onto it),
 * and a mismatch earns a sentence: rigs and patches restore fine across
 * operating systems, but a patch's plugin state names its capture by absolute
 * path, and those paths are per-OS. Better to say so than to let someone find
 * a silent amp. */
export function describeRestoreOutcome(state: BackupState, thisPlatform: string): string {
  const { rigs, patches } = state.counts;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const restored = `Restored ${count(rigs, 'rig', 'rigs')} and ${count(patches, 'patch', 'patches')}.`;

  const crossPlatform =
    state.platform && thisPlatform && state.platform !== thisPlatform
      ? ' It was made on another operating system, so any patch that loads a capture or impulse response will need pointing at this machine’s copy.'
      : '';

  return restored + crossPlatform;
}

/** The slug the engine stamps into an archive, for the platform comparison
    above. AppInfo.platform is the page's only view of which OS this is. */
export function platformSlug(platform: 'windows' | 'macos' | undefined): string {
  if (platform === 'macos') return 'macos-arm64';
  if (platform === 'windows') return 'windows-x64';
  return '';
}
