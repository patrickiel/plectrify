/**
 * When this UI bundle was built, and from which commit — the one thing the
 * engine cannot report, because the exe serves whatever `ui/dist` is on disk and
 * that may be older than the exe itself.
 *
 * Injected by Vite's `define` (see ui/vite.config.ts). The `typeof` guards keep
 * the module usable where the defines are absent — vitest and any consumer that
 * imports it outside a Vite build.
 */

export const UI_BUILD_STAMP: string =
  typeof __UI_BUILD_STAMP__ === 'undefined' ? '' : __UI_BUILD_STAMP__;

export const UI_COMMIT: string = typeof __UI_COMMIT__ === 'undefined' ? '' : __UI_COMMIT__;
