import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_URL_LENGTH, buildBugReportUrl, buildIdeaUrl } from './issueReport';

describe('buildBugReportUrl', () => {
  it('targets the bug form with the report prefilled', () => {
    const { url, overflowed } = buildBugReportUrl('App\n  Version  0.1.0');
    const parsed = new URL(url);

    expect(parsed.pathname.endsWith('/issues/new')).toBe(true);
    expect(parsed.searchParams.get('template')).toBe('bug_report.yml');
    expect(parsed.searchParams.get('diagnostics')).toBe('App\n  Version  0.1.0');
    expect(overflowed).toBe(false);
  });

  it('round-trips characters that would otherwise be eaten in transit', () => {
    // The load-bearing case. juce::URL decodes each query value and re-encodes
    // it before handing the URL to the browser: an unescaped & is dropped, a #
    // truncates the query into an anchor, and a literal + becomes a space. If
    // this assertion fails, reports arrive silently truncated.
    const nasty = 'A & B #tag C+D key=value 100% "quoted"\nsecond line\tand a tab · em—dash';
    const parsed = new URL(buildBugReportUrl(nasty).url);

    expect(parsed.searchParams.get('diagnostics')).toBe(nasty);
    expect(parsed.searchParams.get('template')).toBe('bug_report.yml');
  });

  it('drops the report rather than risk a 414, and says that it did', () => {
    const { url, overflowed } = buildBugReportUrl('x'.repeat(MAX_ISSUE_URL_LENGTH));
    const parsed = new URL(url);

    expect(overflowed).toBe(true);
    expect(parsed.searchParams.get('diagnostics')).toBeNull();
    expect(parsed.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
  });

  it('keeps a report that only just fits', () => {
    // Sized so the finished URL lands exactly on the cap.
    const base = buildBugReportUrl('').url.length;
    const { url, overflowed } = buildBugReportUrl('x'.repeat(MAX_ISSUE_URL_LENGTH - base));

    expect(overflowed).toBe(false);
    expect(url.length).toBe(MAX_ISSUE_URL_LENGTH);
  });

  it('carries a realistic report without overflowing', () => {
    // A busy rig is ~1.6 KB raw and ~3.6 KB encoded — well inside the cap. This
    // guards against someone lowering MAX_ISSUE_URL_LENGTH below the real range.
    const realistic = 'Section\n  Label          value · with — separators\n'.repeat(32);
    expect(realistic.length).toBeGreaterThan(1500);
    expect(buildBugReportUrl(realistic).overflowed).toBe(false);
  });
});

describe('buildIdeaUrl', () => {
  it('targets the idea form and asks for no diagnostics', () => {
    const parsed = new URL(buildIdeaUrl());

    expect(parsed.searchParams.get('template')).toBe('idea.yml');
    expect(parsed.searchParams.get('diagnostics')).toBeNull();
  });
});
