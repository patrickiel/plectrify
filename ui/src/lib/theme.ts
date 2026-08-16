import type { ThemeName } from './engine/types';

/** Pre-paint mirror of the chosen theme. The engine's stored settings arrive
    asynchronously (a file read over the JUCE bridge in the host), so the boot
    script in ui/index.html reads this key synchronously to stamp data-theme
    before the first frame. That script hardcodes the same key — keep them in
    step. Deliberately not routed through EngineBridge: which colours to paint
    is a view concern, and the bridge must not grow an API for it. */
const THEME_KEY = 'plectrify.theme';

/** The theme the boot script already painted with, so the app's initial state
    matches the DOM. Without this, subscribeAppSettings' synchronous first emit
    (which carries the defaults, not the stored settings) would flip an
    already-light page to dark and back again on every launch. */
export function bootTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Paint the theme and keep the boot mirror in step. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Chromium keys the canvas, native scrollbars and form controls off
  // color-scheme — the parts our own CSS can't reach.
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable; the theme still applies for this session and
    // the next launch simply starts from the default until settings load.
  }
}
