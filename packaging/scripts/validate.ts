/**
 * Validate the plugin catalogue without publishing anything.
 *
 *   pnpm --dir packaging validate
 *   pnpm --dir packaging validate -- --verify-assets
 *
 * Called by scripts/release.windows.ts as a pre-flight, so a release can never ship pointing
 * at a catalogue the publish path would have refused. Exits non-zero with a
 * plain-language reason.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scriptArgs } from './cli.ts';
import {
  ManifestError,
  categoryPath,
  readManifest,
  validateManifest,
  verifyAssets,
} from './manifest.ts';

const packagingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    manifest: { type: 'string', default: resolve(packagingDir, 'catalogue.json') },
    // Off by default: it downloads a few hundred megabytes. Worth running
    // before a release, where a rotted upstream URL must fail the build rather
    // than reach users' Packages panels.
    'verify-assets': { type: 'boolean', default: false },
  },
});

try {
  const manifest = await readManifest(resolve(values.manifest!));
  validateManifest(manifest);

  if (values['verify-assets']) {
    console.log('Verifying assets against their pinned hashes ...');
    await verifyAssets(manifest);
  }

  // Counted by kind rather than reported as one total: the number that matters
  // at a glance is how many of these will be executed inside Plectrify.
  const plugins = manifest.packages.filter((p) => p.kind === 'plugin').length;
  const content = manifest.packages.filter((p) => p.kind === 'content').length;
  const bundles = manifest.bundles?.length ?? 0;
  // Counted by whole path, so "Effects > Reverb" and "Effects > Delay" are the
  // two sections they render as rather than one shared parent.
  const sections = new Set(
    manifest.packages.map((p) => categoryPath(p.category).join(' > ')).filter(Boolean),
  );
  console.log(
    `Catalogue OK: revision ${manifest.revision}, ${plugins} plugin${plugins === 1 ? '' : 's'}, ` +
      `${content} content package${content === 1 ? '' : 's'} in ` +
      `${sections.size} section${sections.size === 1 ? '' : 's'}, ` +
      `${bundles} bundle${bundles === 1 ? '' : 's'}${values['verify-assets'] ? ', all assets verified' : ''}.`,
  );
} catch (error) {
  if (error instanceof ManifestError) {
    console.error(`\ncatalogue: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
