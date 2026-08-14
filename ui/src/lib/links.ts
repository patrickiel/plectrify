/**
 * Outbound links to the project's public pages — every one of them in a single
 * file, so moving the repository is one edit.
 *
 * Opened through the engine's `openExternalUrl` rather than an `<a href>`: in
 * the host the UI is a single WebView with no tabs, so a normal link would
 * navigate the app itself away.
 */

const REPO_SLUG = 'patrickiel/plectrify';
const REPO = `https://github.com/${REPO_SLUG}`;

export const REPO_URL = REPO;

/** The product site — downloads, docs, the marketing pages (`site/`). */
export const SITE_URL = 'https://plectrify.com';

/** GitHub's issue composer. Bare — the templates and the prefilled diagnostics
    are layered on by `issueReport.ts`, which is where the query string is built
    and escaped. Nothing should link here without a `?template=`: blank issues
    are disabled on the repo, so this URL alone lands on the template picker. */
export const NEW_ISSUE_BASE_URL = `${REPO}/issues/new`;

/** What changed, per release. The GitHub releases page is the changelog —
    there is no CHANGELOG file in the repository. */
export const CHANGELOG_URL = `${REPO}/releases`;

/** The licence and the third-party attributions it carries (JUCE, WebView2). */
export const NOTICES_URL = `${REPO}/blob/main/THIRD_PARTY_NOTICES.md`;

/** Where the update check sends you to download. Deliberately this static page
    rather than the `html_url` the API hands back: the native side only checks
    for an `https://` prefix before passing a URL to the shell, so no URL built
    out of a network response should ever reach it. */
export const LATEST_RELEASE_URL = `${REPO}/releases/latest`;

/** The endpoint behind the update check. This one already excludes drafts and
    prereleases, so nothing on the client has to filter them out. */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

/** The community server — questions, rig sharing, release announcements. A
    permanent invite (no expiry, no use limit), so it can be baked into shipped
    builds. Must stay an `https://discord.gg/…` URL: the native side only
    launches https, so a `discord://` deep link would be dropped without a
    word. */
export const DISCORD_URL = 'https://discord.gg/dxQBanJr2X';
