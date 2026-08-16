import { describe, expect, it } from 'vitest';
import { parseRenderer } from './browserFacts';

const WEBVIEW2_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3485.44';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.6723.92 Safari/537.36';

// WKWebView, verbatim shape: no Chrome, no Edg — and no Safari or Version
// token either. AppleWebKit's build number is the only version it carries.
const WKWEBVIEW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('parseRenderer', () => {
  it('prefers the Edg token — WebView2 also claims to be Chrome', () => {
    expect(parseRenderer(WEBVIEW2_UA)).toEqual({
      webViewVersion: '141.0.3485.44',
      rendererFamily: 'chromium',
    });
  });

  it('falls back to Chrome for standalone UI work in a plain browser', () => {
    expect(parseRenderer(CHROME_UA)).toEqual({
      webViewVersion: '130.0.6723.92',
      rendererFamily: 'chromium',
    });
  });

  it('reads WKWebView as WebKit — Chromium UAs also claim AppleWebKit, so this must lose to them', () => {
    expect(parseRenderer(WKWEBVIEW_UA)).toEqual({
      webViewVersion: '605.1.15',
      rendererFamily: 'webkit',
    });
  });

  it('returns empty for anything it does not recognise, rather than a guess', () => {
    for (const ua of ['', 'Edgy/1.2.3', 'curl/8.4.0']) {
      expect(parseRenderer(ua)).toEqual({ webViewVersion: '', rendererFamily: '' });
    }
  });
});
