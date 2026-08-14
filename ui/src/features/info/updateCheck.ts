/**
 * Is there a newer Plectrify than this one? Pure comparison plus the single
 * request that answers it — no state, so every rule here is unit-testable.
 *
 * The app ships as a locally-built installer attached to a GitHub release, so
 * "the newest version" is exactly the newest published release's tag.
 */
import { LATEST_RELEASE_API_URL } from '../../lib/links';

/** Only MAJOR.MINOR.PATCH, optionally tagged with a leading `v` — the release
    tags carry one and the titles do not. Matches scripts/release.windows.ts's own guard, so
    the only versions this repo can publish are exactly the ones it accepts. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/i;

/** The three numeric parts, or null for anything else: the empty string before
    the engine has pushed a version, the mock's 'dev', a hand-cut tag like
    'nightly' or '0.2.0-rc1'. Strict on purpose — what cannot be compared is
    not news, and guessing would mean nagging about a release that isn't one. */
export function parseVersion(value: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True only when both sides parse and `candidate` is strictly newer. Compared
    part by part rather than as strings, which would put 0.9.0 above 0.10.0. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Whether a newer release exists at all. What the About dialog's manual check
    reports: the user asked, so they get the truth regardless of dismissals. */
export function hasUpdate(installed: string, latest: string): boolean {
  return isNewerVersion(latest, installed);
}

/** Whether the *unbidden* start-up notice should appear — `hasUpdate` plus the
    dismissal. Scoped to the offered release rather than a plain flag, so
    waving away 0.2.0 stays quiet for 0.2.0 but 0.3.0 is news again. */
export function shouldOfferUpdate(installed: string, latest: string, dismissed: string): boolean {
  return hasUpdate(installed, latest) && latest !== dismissed;
}

/** Ask GitHub for the newest published release; its version with any leading
    `v` stripped, or null when anything at all goes wrong — offline, rate
    limited, a body we do not recognise.
 *
 * One plain GET with no custom headers: any header would turn this into a
 * preflighted cross-origin request, and the unauthenticated API answers a bare
 * GET with `Access-Control-Allow-Origin: *`. Nothing is sent but the request
 * itself, and nothing is logged on failure — the user did not ask for this. */
export async function fetchLatestReleaseTag(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(LATEST_RELEASE_API_URL, { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== 'string') return null;
    return body.tag_name.trim().replace(/^v/i, '');
  } catch {
    return null;
  }
}
