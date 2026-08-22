import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { DEV_SERVER_PORT } from '../scripts/devServer.ts';

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
  // Plectrify's own port, declared once in scripts/devServer.ts and shared with
  // the dev loop that goes looking for this server. Vite's default 5173 is a
  // port every project on the machine competes for: whoever starts first wins
  // it, and the app then either finds someone else's UI there or finds nothing
  // because Vite quietly moved us to 5174. strictPort is the second half of
  // that — if this port is somehow taken, failing here is far cheaper than
  // starting somewhere nothing is looking.
  server: { port: DEV_SERVER_PORT, strictPort: true },
  preview: { port: DEV_SERVER_PORT, strictPort: true },
  define: {
    // Minute precision: this is provenance, not a benchmark.
    __UI_BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
    __UI_COMMIT__: JSON.stringify(uiCommit()),
  },
});
