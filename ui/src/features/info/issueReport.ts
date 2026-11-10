/**
 * Composes the GitHub issue URLs behind "Report a bug" and "Suggest an idea".
 *
 * The bug form arrives with the diagnostics already pasted in, so the well
 * behaved path costs the user nothing. The same field is `required: true` in
 * `.github/ISSUE_TEMPLATE/bug_report.yml`, which covers the other path — filing
 * from a browser, where we cannot prefill anything.
 */
import { NEW_ISSUE_BASE_URL } from '../../lib/links';

/** Query-parameter names are the `id:` of each field in the issue form. Renaming
    one there without changing it here breaks the prefill silently — GitHub just
    ignores a parameter that matches no field. */
const BUG_TEMPLATE = 'bug_report.yml';
const IDEA_TEMPLATE = 'idea.yml';
const DIAGNOSTICS_FIELD = 'diagnostics';

/** Length past which the report is left out of the URL. GitHub answers 414
    somewhere around 8 KB of URI; the margin below that is for the prose the user
    types *after* this URL is built, which would be lost with the whole page. */
export const MAX_ISSUE_URL_LENGTH = 6000;

export interface IssueUrl {
  url: string;
  /** True when a shorter version of the report went in because the full one
      did not fit. The report says itself what it left out. */
  abridged: boolean;
  /** True when no version of the report fit and it was left out — the caller
      has to put it on the clipboard and say so, because the form field is
      required. */
  overflowed: boolean;
}

/** Build one query string, escaping every value.
 *
 * `encodeURIComponent` on each value is not cosmetic. The native side hands the
 * finished string to `juce::URL`, which decodes each query value on the way in
 * and re-encodes it on the way out to the browser — so an unescaped `&` in a
 * value is silently dropped, a `#` truncates the query into an anchor, and a
 * literal `+` arrives as a space. Escaped, that round-trip is lossless. */
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

/** The bug form, with the environment report prefilled where it fits.

    `diagnostics` is the report, or several versions of it from fullest to
    shortest (`abridgedDiagnostics`): the first whose URL fits goes in. */
export function buildBugReportUrl(diagnostics: string | readonly string[]): IssueUrl {
  const versions = typeof diagnostics === 'string' ? [diagnostics] : diagnostics;
  for (const [index, report] of versions.entries()) {
    const url = `${NEW_ISSUE_BASE_URL}?${query({
      template: BUG_TEMPLATE,
      [DIAGNOSTICS_FIELD]: report,
    })}`;
    if (url.length <= MAX_ISSUE_URL_LENGTH) return { url, abridged: index > 0, overflowed: false };
  }

  // Still open the form — an issue with the diagnostics pasted by hand beats no
  // issue at all, and the caller tells the user where to find them.
  return {
    url: `${NEW_ISSUE_BASE_URL}?${query({ template: BUG_TEMPLATE })}`,
    abridged: false,
    overflowed: true,
  };
}

/** The idea form. No diagnostics, so nothing to overflow. */
export function buildIdeaUrl(): string {
  return `${NEW_ISSUE_BASE_URL}?${query({ template: IDEA_TEMPLATE })}`;
}
