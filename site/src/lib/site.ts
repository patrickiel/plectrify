/**
 * Every fact about the product that appears in more than one place on the site.
 *
 * Nothing here names a release. The download buttons point at GitHub's
 * `/releases/latest/download/<file>`, which serves that file from whichever
 * release is currently promoted, so a release moves them without touching this
 * repo or redeploying the site. That is also why it is not a build-time fetch
 * of the releases API: a static site that calls an API at build time is a site
 * whose deploy can fail because someone else's service is having a bad morning.
 */

/** Marketing name. The codebase is still called Plectrify: repository URLs,
    release asset names and the installed app all keep that name until the
    rename lands, so those live in their own constants below rather than being
    derived from this one. */
export const PRODUCT = 'Plectrify';

export const TAGLINE = 'Your pedalboard, without the DAW.';

/**
 * The one-line answer to "what is this", sitting directly under the headline.
 *
 * The headline sells the result and this says what the thing is, in that order.
 * One sentence, deliberately: an earlier hero followed it with a second
 * paragraph of the same information in softer words, and the pair read as
 * padding. The TONE3000 sentence that completes the paragraph lives in
 * +page.svelte because it ends in their wordmark, which is markup.
 */
export const IDENTITY = 'Chain your VST plugins and play.';

/**
 * The `<meta name="description">` text, which is a different job from LEAD: it
 * is read by search engines and link previews, not by a visitor deciding
 * whether to care. So this one *does* carry the searchable words ("VST3",
 * "amp sim"), because they are what someone looking for this actually types.
 */
export const DESCRIPTION =
  'A free guitar rig for Windows, macOS and Linux. Plug in and play through your own VST3 amp sims ' +
  'and pedals, chained like a real pedalboard, or load thousands of real amp captures from ' +
  'TONE3000. Tuner, metronome, looper and setlists for practice and for playing live.';

export const REPO = 'https://github.com/patrickiel/plectrify';

/** The community server. A permanent invite (no expiry, no use limit), so it
    can sit in shipped pages and builds without going stale. The app carries the
    same URL in `ui/src/lib/links.ts`; keep the two in step. */
export const DISCORD_URL = 'https://discord.gg/dxQBanJr2X';

/** Release-asset naming, as produced by scripts/release.windows.ts and its mac
    and Linux twins. These still say "Plectrify" because the built artefacts do.
    The names carry no version, and must not start to: a fixed name is what lets
    `/releases/latest/download/` find the file in every release. */
const ASSET_BASE = 'Plectrify';

/** The three desktop platforms, in the spelling the pre-paint OS probe in
    app.html stamps onto `<html data-os>`. One concept, used for the glyph, the
    styling hook and the detection match, so they cannot drift apart. */
export type Platform = 'windows' | 'macos' | 'linux';

export interface Download {
  platform: Platform;
  os: string;
  file: string;
  url: string;
}

/** The newest *promoted* release's copy of `file`. GitHub's "latest" skips
    pre-releases, so a release reaches these buttons when the Promote workflow
    runs and not before: until then they keep serving the previous one. */
const asset = (file: string) => `${REPO}/releases/latest/download/${file}`;

export const DOWNLOADS: Download[] = [
  {
    platform: 'windows',
    os: 'Windows',
    file: `${ASSET_BASE}-win-x64-setup.exe`,
    url: asset(`${ASSET_BASE}-win-x64-setup.exe`),
  },
  {
    platform: 'macos',
    os: 'macOS',
    file: `${ASSET_BASE}-macos-arm64.pkg`,
    url: asset(`${ASSET_BASE}-macos-arm64.pkg`),
  },
  {
    platform: 'linux',
    os: 'Linux',
    file: `${ASSET_BASE}-linux-x64.deb`,
    url: asset(`${ASSET_BASE}-linux-x64.deb`),
  },
];

export const RELEASES_URL = `${REPO}/releases`;

/**
 * The demo video. Set `youtubeId` once there is one; until then the landing
 * page renders an honest placeholder rather than a broken embed: a dead
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
