import type { Handle } from '@sveltejs/kit';

/**
 * Adds fonts to SvelteKit's preload set (the default is js + css alone). The
 * fonts live in src/lib/fonts and are pulled in through app.css, so Vite has
 * them in its manifest and `resolve` can emit a `<link rel="preload">` for
 * each, with the fingerprinted URL, which a hand-written tag in app.html
 * could never carry. Every route is prerendered, so this runs once at build
 * time and the tags are baked into the static HTML.
 *
 * Preloading Chakra Petch is not a contradiction of its font-display:
 * optional (see app.css): optional only uses a font already in cache at first
 * paint, which is exactly what a preload makes likely on all but the slowest
 * connections, and on those, optional still means no reflow.
 */
export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event, {
    preload: ({ type }) => type === 'font' || type === 'js' || type === 'css',
  });
};
