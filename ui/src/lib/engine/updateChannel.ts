/**
 * The Linux update notice's facts, and the wording they decide.
 *
 * Linux installs update through APT: the .deb registers Plectrify's signed
 * repository, and a new version arrives with the system's own updates. So the
 * notice there has nothing to download — but it learns of a release from
 * GitHub the moment it is promoted, while APT learns of it on its next index
 * refresh, daily by default. A player who reads the notice and opens Software
 * Updater straight away finds nothing to install and concludes the notice is
 * wrong. This module is what lets it say where the index stands instead.
 *
 * The engine answers on the `updateChannel` stream (Source/update/
 * SystemUpdateChannel.h): which version APT's index offers, whether the
 * sources entry the installer wrote is still on disk, and which desktop
 * updater is installed. Here is the stream's shape, the reducer, the verdict
 * the notice draws from it and the wording, which lives on the page for the
 * same reason `describeUpdateInstallError`'s does.
 *
 * Deliberately no refresh of the index from the app: it would be a password
 * prompt and a root process to turn `sudo apt update` into a click, so the
 * notice prints the command instead. Linux standalone only
 * (HostCapabilities.systemUpdates); the plugin keeps the wording and offers no
 * button.
 */
import { isNewerVersion, parseVersion } from '../../features/info/updateCheck';

/** The desktop updaters the engine knows how to open, by executable name. */
export type SystemUpdater = 'update-manager' | 'gnome-software' | 'plasma-discover';

const UPDATERS: SystemUpdater[] = ['update-manager', 'gnome-software', 'plasma-discover'];

export interface UpdateChannelState {
  /** False until the engine's first probe has answered — before that, and on
      a host without the capability, the notice keeps its generic wording. */
  probed: boolean;
  /** The updater the engine found on this desktop; empty when none. */
  updater: SystemUpdater | '';
  /** The version APT's index would install; empty when it offers none. */
  candidate: string;
  /** The sources entry the .deb wrote is still on disk. */
  sourceInstalled: boolean;
}

export const IDLE_UPDATE_CHANNEL: UpdateChannelState = {
  probed: false,
  updater: '',
  candidate: '',
  sourceInstalled: false,
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Folds one engine push into the page's state. Total over whatever arrives:
    the stream crosses the bridge as loose JSON, and an updater this build has
    no label for is reported as none rather than as a button with no name. */
export function reduceUpdateChannelState(
  previous: UpdateChannelState,
  event: unknown,
): UpdateChannelState {
  if (typeof event !== 'object' || event === null) return previous;
  const raw = event as Record<string, unknown>;
  const updater = str(raw.updater) as SystemUpdater;

  return {
    probed: raw.probed === true,
    updater: UPDATERS.includes(updater) ? updater : '',
    candidate: str(raw.candidate),
    sourceInstalled: raw.sourceInstalled === true,
  };
}

/** The updater's name as its desktop prints it, for the button. */
export function describeSystemUpdater(updater: SystemUpdater | ''): string {
  switch (updater) {
    case 'update-manager':
      return 'Software Updater';
    case 'gnome-software':
      return 'Software';
    case 'plasma-discover':
      return 'Discover';
    default:
      return 'Software Updater';
  }
}

/** What the notice should say and offer:
 *
 *  - `unknown`: no probe has answered (or the host has none) — the generic line.
 *  - `ready`: APT's index already has the release; open the updater.
 *  - `pending`: the index has not noticed it yet; say so, with the command.
 *  - `sourceMissing`: the sources entry is gone — reinstall from the download.
 *
 *  The updater is offered on `ready` alone: opened before the index has the
 *  release it shows nothing to install, which is the confusion the whole
 *  channel exists to end. */
export type UpdateChannelVerdict = 'unknown' | 'ready' | 'pending' | 'sourceMissing';

/** Draws the verdict for the release `latest` the notice is offering. */
export function judgeUpdateChannel(
  latest: string,
  state: UpdateChannelState,
): UpdateChannelVerdict {
  if (!state.probed) return 'unknown';
  if (!state.sourceInstalled) return 'sourceMissing';
  // The index offers the release (or something past it): nothing stands
  // between the player and the updater. Strict on the parse — a candidate in
  // a shape this cannot compare is not evidence either way.
  if (parseVersion(state.candidate) !== null && !isNewerVersion(latest, state.candidate))
    return 'ready';
  return 'pending';
}

/** The notice's line under the version, per verdict. `command` is the shell
    equivalent, rendered as code beside the text where one applies. */
export function describeUpdateChannel(
  verdict: UpdateChannelVerdict,
  latest: string,
  updater: SystemUpdater | '',
): { text: string; command?: string } {
  const name = describeSystemUpdater(updater);
  switch (verdict) {
    case 'ready':
      return { text: `Your system has it: open ${name}, or run`, command: 'sudo apt upgrade' };
    case 'pending':
      return {
        text: `${name} will offer it after its next check, usually within a day. To get it now, run`,
        command: 'sudo apt update && sudo apt upgrade',
      };
    case 'sourceMissing':
      return {
        text: "This computer is no longer subscribed to Plectrify's updates (the installer's APT source is gone). Reinstall from the download to subscribe it again.",
      };
    default:
      return {
        text: `It installs with your system updates: open ${name}, or run`,
        command: 'sudo apt update && sudo apt upgrade',
      };
  }
}
