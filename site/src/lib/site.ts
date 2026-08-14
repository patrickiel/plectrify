/**
 * Every fact about the product that appears in more than one place on the site.
 *
 * The release constants are deliberately plain data rather than a build-time
 * fetch of the GitHub releases API. A static site that calls an API at build
 * time is a site whose deploy can fail because someone else's service is
 * having a bad morning, and it buys nothing here: a release already touches
 * this repo, so it can touch one more line. Bump `version` in the same commit
 * that publishes the release and the download buttons follow.
 */

/** Marketing name. The codebase is still called Plectrify — repository URLs,
    release asset names and the installed app all keep that name until the
    rename lands, so those live in their own constants below rather than being
    derived from this one. */
export const PRODUCT = 'Plectrify';

export const TAGLINE = 'Your pedalboard, without the DAW.';

/**
 * The one-line answer to "what is this", sitting directly under the headline.
 *
 * The headline sells the result and this says what the thing is, in that order.
 * Leading with "standalone VST3 host" describes the machinery to someone who
 * already knows what a plugin host is, and says nothing at all to the guitarist
 * who does not — but withholding it entirely leaves that first reader guessing
 * whether this is even the category of software they are looking for. So it
 * lands second, once, in a full sentence rather than as a spec.
 */
export const IDENTITY = 'A standalone guitar rig that runs your VST3 amp sims and pedals.';

/** The paragraph under IDENTITY: what it is like to use, in plain words. No
    acronyms, and no borrowed studio vocabulary — "nothing to arm" means
    nothing to a guitarist who has never opened a DAW, which is the reader this
    sentence exists for. */
export const LEAD =
  'Build a chain of amps and effects, tune up, and play. No session to set up, no ' +
  'recording to manage. Just your rig and your guitar.';

/**
 * The `<meta name="description">` text, which is a different job from LEAD: it
 * is read by search engines and link previews, not by a visitor deciding
 * whether to care. So this one *does* carry the searchable words — "VST3",
 * "amp sim" — because they are what someone looking for this actually types.
 */
export const DESCRIPTION =
  'A free guitar rig for Windows and macOS. Plug in and play through your own VST3 amp sims ' +
  'and pedals, chained like a real pedalboard, or load thousands of real amp captures from ' +
  'TONE3000. Tuner, metronome, looper and setlists for practice and for playing live.';

export const REPO = 'https://github.com/patrickiel/plectrify';

/** The community server. A permanent invite — no expiry, no use limit — so it
    can sit in shipped pages and builds without going stale. The app carries the
    same URL in `ui/src/lib/links.ts`; keep the two in step. */
export const DISCORD_URL = 'https://discord.gg/dxQBanJr2X';

/**
 * The version the download buttons point at.
 *
 * Written by `pnpm release:promote`, which rewrites this line, commits it and
 * deploys the site — so it names the newest *promoted* release rather than
 * whatever `/VERSION` happens to say mid-release. Those two differ for the
 * whole life of a pre-release, which is the point: the buttons below deep-link
 * to a tag, and GitHub serves a pre-release's assets from that path as readily
 * as a promoted one. Only promotion moves this.
 *
 * Editing it by hand is fine; it is a plain constant and the release script
 * only cares that the declaration keeps this shape.
 */
export const VERSION = '0.1.0';

/** Release-asset naming, as produced by scripts/release.windows.ts and its mac
    twin. These still say "Plectrify" because the built artefacts do. */
const ASSET_BASE = 'Plectrify';

/** The two desktop platforms, in the spelling the pre-paint OS probe in
    app.html stamps onto `<html data-os>`. One concept, used for the glyph, the
    styling hook and the detection match — so they cannot drift apart. */
export type Platform = 'windows' | 'macos';

export interface Download {
  platform: Platform;
  os: string;
  /** Shown under the button — what the user needs to know before clicking. */
  requirement: string;
  file: string;
  url: string;
}

const asset = (file: string) => `${REPO}/releases/download/v${VERSION}/${file}`;

export const DOWNLOADS: Download[] = [
  {
    platform: 'windows',
    os: 'Windows',
    requirement: 'Windows 10 or 11, 64-bit',
    file: `${ASSET_BASE}-${VERSION}-win-x64-setup.exe`,
    url: asset(`${ASSET_BASE}-${VERSION}-win-x64-setup.exe`),
  },
  {
    platform: 'macos',
    os: 'macOS',
    requirement: 'Apple Silicon, macOS 13.3+',
    file: `${ASSET_BASE}-${VERSION}-macos-arm64.dmg`,
    url: asset(`${ASSET_BASE}-${VERSION}-macos-arm64.dmg`),
  },
];

export const RELEASES_URL = `${REPO}/releases`;

/**
 * The demo video. Set `youtubeId` once there is one; until then the landing
 * page renders an honest placeholder rather than a broken embed — a dead
 * iframe on the front page reads as an abandoned product, an empty frame
 * saying "coming soon" reads as an early one.
 */
export const VIDEO: { youtubeId: string | null; title: string; posterAlt: string } = {
  youtubeId: null,
  title: `${PRODUCT} in 90 seconds`,
  posterAlt: `A ${PRODUCT} rack with an overdrive, amp sim and reverb chained left to right`,
};

export const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/#video', label: 'Demo' },
  { href: '/docs', label: 'Docs' },
  { href: '/#download', label: 'Download' },
];
