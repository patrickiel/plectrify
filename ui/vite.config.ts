import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/** Short commit of the tree this bundle was built from, or '' outside a repo.
    The About dialog reports it beside the exe's own commit: the C++ app serves
    whatever `ui/dist` happens to be on disk, so a stale bundle is a real state
    and one worth being able to see in a bug report. */
function uiCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  define: {
    // Minute precision: this is provenance, not a benchmark.
    __UI_BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    __UI_COMMIT__: JSON.stringify(uiCommit()),
  },
});
