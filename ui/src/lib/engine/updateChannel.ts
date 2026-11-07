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
 * sources entry the installer wrote is still on disk, which desktop updater is
 * installed, and whether a refresh — Plectrify's source alone, under pkexec's
 * own password prompt — can be asked for. Here is the stream's shape, the
 * reducer, the verdict the notice draws from it and the wording, which lives
 * on the page for the same reason `describeUpdateInstallError`'s does.
 *
 * Linux standalone only (HostCapabilities.systemUpdates); the plugin keeps the
 * wording and offers no button.
 */
import { isNewerVersion, parseVersion } from '../../features/info/updateCheck';

/** The desktop updaters the engine knows how to open, by executable name. */
export type SystemUpdater = 'update-manager' | 'gnome-software' | 'plasma-discover';

const UPDATERS: SystemUpdater[] = ['update-manager', 'gnome-software', 'plasma-discover'];

/** Where a refresh of Plectrify's APT source stands. `declined` is the
    password prompt dismissed — "not now", which lands back on the offer. */
export type UpdateChannelRefresh = 'idle' | 'refreshing' | 'done' | 'declined' | 'failed';

const REFRESHES: UpdateChannelRefresh[] = ['idle', 'refreshing', 'done', 'declined', 'failed'];

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
  /** pkexec and apt-get are both there to run a refresh with. */
  canRefresh: boolean;
  refresh: UpdateChannelRefresh;
}

export const IDLE_UPDATE_CHANNEL: UpdateChannelState = {
  probed: false,
  updater: '',
  candidate: '',
  sourceInstalled: false,
  canRefresh: false,
  refresh: 'idle',
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Folds one engine push into the page's state. Total over whatever arrives:
    the stream crosses the bridge as loose JSON, and an updater this build has
    no label for is reported as none rather than as a button with no name. */
export function reduceUpdateChannelState(
  previous: UpdateChannelState,
  event: unknown,
): UpdateChannelState {
  const raw = (event ?? {}) as Record<string, unknown>;
  const refresh = str(raw.refresh) as UpdateChannelRefresh;
  if (!REFRESHES.includes(refresh)) return previous;
  const updater = str(raw.updater) as SystemUpdater;

  return {
    probed: raw.probed === true,
    updater: UPDATERS.includes(updater) ? updater : '',
    candidate: str(raw.candidate),
    sourceInstalled: raw.sourceInstalled === true,
    canRefresh: raw.canRefresh === true,
    refresh,
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
 *  - `pending`: the index has not noticed it yet; say so and offer a refresh.
 *  - `refreshing`: the refresh is running (its password prompt may be up).
 *  - `refreshFailed`: pkexec or apt-get failed, or the fetch did (no network, or
 *    a source whose key no longer verifies); the terminal is the way to see why.
 *  - `sourceMissing`: the sources entry is gone — reinstall from the download.
 *  - `sourceStale`: refreshed, and the source still cannot see the release —
 *    an older installer's entry, or a changed repository; reinstall likewise. */
export type UpdateChannelVerdict =
  | 'unknown'
  | 'ready'
  | 'pending'
  | 'refreshing'
  | 'refreshFailed'
  | 'sourceMissing'
  | 'sourceStale';

/** Draws the verdict for the release `latest` the notice is offering. */
export function judgeUpdateChannel(
  latest: string,
  state: UpdateChannelState,
): UpdateChannelVerdict {
  if (!state.probed) return 'unknown';
  if (state.refresh === 'refreshing') return 'refreshing';
  if (!state.sourceInstalled) return 'sourceMissing';
  // The index offers the release (or something past it): nothing stands
  // between the player and the updater. Strict on the parse — a candidate in
  // a shape this cannot compare is not evidence either way.
  if (parseVersion(state.candidate) !== null && !isNewerVersion(latest, state.candidate))
    return 'ready';
  // A refresh that succeeded is the proof: the index is fresh and still blind
  // to the release, so the source itself is what is out of date — or the
  // repository is still being published, which is why the actions below keep
  // offering a refresh on this verdict rather than only the download.
  if (state.refresh === 'done') return 'sourceStale';
  if (state.refresh === 'failed') return 'refreshFailed';
  return 'pending';
}

/** Which buttons a verdict earns. One rule for the notice and the About
 *  row, so the two cannot drift on the question issue #38 is about: the
 *  updater is offered only once APT's index has the release, because opening
 *  it before that shows nothing to install, which is the whole confusion. A
 *  refresh is offered while the index is behind, after one failed, and after
 *  one succeeded without finding the release — the repository may still have
 *  been publishing a minute after promotion, and the next refresh is cheaper
 *  than a reinstall. The download is the answer once the source itself is
 *  gone or stale, beside that second refresh in the stale case. */
export interface UpdateChannelActions {
  refresh: boolean;
  updater: boolean;
  download: boolean;
}

export function updateChannelActions(
  verdict: UpdateChannelVerdict,
  state: UpdateChannelState,
): UpdateChannelActions {
  return {
    refresh:
      state.canRefresh &&
      (verdict === 'pending' || verdict === 'refreshFailed' || verdict === 'sourceStale'),
    updater: state.updater !== '' && verdict === 'ready',
    download: verdict === 'sourceMissing' || verdict === 'sourceStale',
  };
}

/** The notice's line under the version, per verdict. `command` is the shell
    equivalent, rendered as code beside the text where one applies.
    `canRefresh` is whether a Refresh button stands beside the line: the
    wording must not point at one a machine without pkexec never gets. */
export function describeUpdateChannel(
  verdict: UpdateChannelVerdict,
  latest: string,
  updater: SystemUpdater | '',
  canRefresh = true,
): { text: string; command?: string } {
  const name = describeSystemUpdater(updater);
  switch (verdict) {
    case 'ready':
      return { text: `Your system has it: open ${name}, or run`, command: 'sudo apt upgrade' };
    case 'pending':
      return {
        text: canRefresh
          ? `${name} may not list it yet — it will on its next check. Refresh to bring that forward, or run`
          : `${name} may not list it yet — it will on its next check. To bring that forward, run`,
        command: 'sudo apt update',
      };
    case 'refreshing':
      return { text: 'Refreshing the package list…' };
    case 'refreshFailed':
      return {
        text: "Couldn't refresh the package list — check your connection and try again, or run this in a terminal to see why (if it keeps failing, reinstall from the download):",
        command: 'sudo apt update',
      };
    case 'sourceMissing':
      return {
        text: "This computer is no longer subscribed to Plectrify's updates (the installer's APT source is gone). Reinstall from the download to subscribe it again.",
      };
    case 'sourceStale':
      return {
        text: canRefresh
          ? `Your APT source can't see ${latest} — it may be from an older installer, or the release is still being published. Refresh again in a minute, or reinstall from the download to put this computer back on the update channel.`
          : `Your APT source can't see ${latest} — it may be from an older installer. Reinstall from the download to put this computer back on the update channel.`,
      };
    default:
      return {
        text: `It installs with your system updates: open ${name}, or run`,
        command: 'sudo apt update && sudo apt upgrade',
      };
  }
}
