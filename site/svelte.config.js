import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { mdsvex } from 'mdsvex';

/**
 * mdsvex reads the layout off disk itself and then injects its path as an
 * import into every compiled `.md`, so the string has to satisfy both: a
 * relative path resolves against each doc's own folder when imported, and the
 * `$lib` alias is meaningless to `readFileSync`. An absolute path is the only
 * form that works for both — with forward slashes, since on Windows the
 * backslashes would be read as escapes inside the generated import.
 */
const docsLayout = fileURLToPath(new URL('./src/lib/docs/_docs.svelte', import.meta.url)).replace(
  /\\/g,
  '/',
);

/**
 * Fully static: every route is prerendered to HTML at build time (see
 * `src/routes/+layout.ts`), so the deployed site is a folder of files with no
 * server behind it. `fallback` is deliberately unset — a static fallback page
 * would turn a typo'd URL into a 200, which costs us the 404 that both users
 * and search engines rely on.
 *
 * Docs are `.md` handled by mdsvex, so a new page is a file rather than a route
 * component. `_docs.svelte` wraps every one of them in the shared prose shell,
 * which is why no doc has to remember to import it.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
  extensions: ['.svelte', '.md'],
  preprocess: [
    mdsvex({
      extensions: ['.md'],
      layout: { _: docsLayout },
    }),
  ],
  kit: {
    adapter: adapter({ strict: true }),
    prerender: {
      // A broken internal link should fail the build, not ship.
      handleHttpError: 'fail',
    },
  },
};
