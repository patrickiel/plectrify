/** What the page itself can see about where it is running. The engine reports
    the machine; this reports the renderer — on Windows the WebView2 runtime, a
    separately-updated component and therefore its own source of "works on my
    machine"; on macOS the OS-shipped WKWebView, whose WebKit build moves with
    macOS updates. */

export interface BrowserFacts {
  /** WebView2 / Chromium / WebKit version behind the page, '' when
      unrecognisable. */
  webViewVersion: string;
  /** Which engine the version number belongs to. Decided by the UA rather
      than by the OS, so a plain-browser mock session reports whatever is
      actually rendering it. */
  rendererFamily: 'chromium' | 'webkit' | '';
  /** CSS-pixel viewport, and the ratio it renders at. */
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  /** UI language and IANA time zone, as the page resolves them. */
  language: string;
  timeZone: string;
}

/** Pulls the renderer build and family out of a user-agent string.
 *
 * WebView2 identifies itself with an `Edg/<version>` token (the whole UA
 * otherwise claims to be Chrome). Falling back to `Chrome/<version>` keeps the
 * row useful in a plain browser during standalone UI work. WKWebView's UA
 * carries neither — and no `Safari/` or `Version/` token either, only
 * `AppleWebKit/<build>` — so that is the macOS branch, reported as WebKit's
 * own build number. Ordered Chromium-first: every Chromium UA also claims
 * AppleWebKit/537.36 for legacy compatibility, so matching WebKit first would
 * mislabel them all. */
export function parseRenderer(
  userAgent: string,
): Pick<BrowserFacts, 'webViewVersion' | 'rendererFamily'> {
  const edge = /\bEdg\/([\d.]+)/.exec(userAgent);
  if (edge) return { webViewVersion: edge[1], rendererFamily: 'chromium' };
  const chrome = /\bChrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return { webViewVersion: chrome[1], rendererFamily: 'chromium' };
  const webkit = /\bAppleWebKit\/([\d.]+)/.exec(userAgent);
  if (webkit) return { webViewVersion: webkit[1], rendererFamily: 'webkit' };
  return { webViewVersion: '', rendererFamily: '' };
}

/** Reads the live values. Kept apart from the report builder so the builder
    stays a pure function of its input and can be tested without a DOM. */
export function collectBrowserFacts(): BrowserFacts {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    // Some runtimes refuse to resolve a zone; the row dashes out rather than
    // failing the whole report over a nicety.
  }

  return {
    ...parseRenderer(navigator.userAgent),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    language: navigator.language ?? '',
    timeZone,
  };
}
