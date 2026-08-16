/// <reference types="svelte" />
/// <reference types="vite/client" />

// Build-time provenance for the UI bundle, injected by vite.config.ts's
// `define`. Read through lib/buildStamp.ts, which guards their absence outside
// a Vite build (vitest).
declare const __UI_BUILD_STAMP__: string;
declare const __UI_COMMIT__: string;
