/**
 * Validate, sign and publish the plugin catalogue.
 *
 *   pnpm --dir packaging publish-catalogue --dry-run
 *   pnpm --dir packaging publish-catalogue
 *
 * The signing key is found at ~/.plectrify/catalogue-signing.key, or wherever
 * $PLECTRIFY_SIGNING_KEY or --key says. See resolveSigningKey in cli.ts.
 *
 * This is deliberately separate from the app release: the whole point of
 * hosting the catalogue is that the offered plugins — and their notices — can
 * change without shipping a new installer. Editing catalogue.json and
 * running this is the entire update path.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSigningKey, scriptArgs, signingKeySearchOrder } from './cli.ts';
import { ManifestError, readManifest, validateManifest, verifyAssets } from './manifest.ts';
import { R2_PUBLIC_BASE } from './pack.ts';
import { sha256Hex, signDigest, verifySignature } from './signing.ts';
import { wranglerInherit } from './wrangler.ts';

const packagingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    key: { type: 'string' },
    manifest: { type: 'string', default: resolve(packagingDir, 'catalogue.json') },
    bucket: { type: 'string', default: 'plectrify' },
    prefix: { type: 'string', default: 'plugins/v1' },
    // Must match PLECTRIFY_CATALOGUE_URL in CMakeLists.txt — that is where the
    // shipped app looks. Publishing anywhere else silently strands every user
    // on their cached catalogue, which is why the post-condition re-fetches
    // from exactly this URL.
    'base-url': {
      type: 'string',
      default: `${R2_PUBLIC_BASE}/plugins/v1`,
    },
    'skip-asset-verification': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`\ncatalogue: ${message}`);
  process.exit(1);
}

function upload(args: string[]): void {
  if (!wranglerInherit(args)) fail(`wrangler ${args.slice(0, 3).join(' ')} failed.`);
}

// --- 0. Find the key -------------------------------------------------------
// Before validating, not after: --verify-assets re-downloads every pinned
// binary, and discovering there is nothing to sign with at the end of that is
// several minutes wasted on a failure known up front.
const signingKey = resolveSigningKey(values.key, '--key');

if (!values['dry-run'] && !existsSync(signingKey.path)) {
  fail(
    `no signing key at ${signingKey.path} (from ${signingKey.origin}).\n\n` +
      `Looked in order:\n${signingKeySearchOrder('--key')}\n\n` +
      'If the key exists elsewhere, point at it rather than generating a new one: ' +
      'every shipped build verifies against the public half of the original, so a ' +
      'second keypair silently strands every install on its cached catalogue.',
  );
}

// --- 1. Validate -----------------------------------------------------------
const manifestPath = resolve(values.manifest!);
console.log(`==> Validating ${manifestPath}`);

const manifest = await readManifest(manifestPath);
try {
  validateManifest(manifest);
} catch (error) {
  if (error instanceof ManifestError) fail(error.message);
  throw error;
}

// --- 2. Verify the pins still resolve --------------------------------------
if (!values['skip-asset-verification']) {
  console.log('==> Verifying assets against their pinned hashes');
  try {
    await verifyAssets(manifest);
  } catch (error) {
    if (error instanceof ManifestError) fail(error.message);
    throw error;
  }
}

if (values['dry-run']) {
  console.log('\nValidation passed. Nothing published (--dry-run).');
  process.exit(0);
}

// --- 3. Bump the revision --------------------------------------------------
// Monotonic, so an unexpected rollback is visible rather than silent.
manifest.revision += 1;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`==> revision -> ${manifest.revision}`);

// --- 4. Sign ---------------------------------------------------------------
// Sign the bytes on disk, not a re-serialised copy: a single differing byte
// fails verification for every user.
const bytes = await readFile(manifestPath);
const digest = sha256Hex(bytes);

console.log(`==> Signing with ${signingKey.path}`);
const privateKey = (await readFile(signingKey.path, 'utf8')).trim();
const signature = signDigest(digest, privateKey);
const signaturePath = `${manifestPath}.sig`;
await writeFile(signaturePath, signature, 'ascii');

// --- 5. Upload, signature first --------------------------------------------
// If the upload is interrupted between the two objects, a stale signature
// against a new manifest fails closed: clients reject the pair and keep using
// their cached catalogue. Uploading the manifest first would instead leave a
// window where the live catalogue is rejected by everyone.
console.log(`==> Uploading to r2://${values.bucket}/${values.prefix}`);

// Cache-Control is the update mechanism, so it is set deliberately rather than
// left to a default. Five minutes: long enough for the CDN to absorb a launch
// spike, short enough that a bad pin can be pulled within minutes. The assets
// themselves never change — they sit at version-tagged upstream URLs and are
// checksum-pinned — so only this pair is ever republished.
const cacheControl = 'public, max-age=300';

upload([
  'r2', 'object', 'put', `${values.bucket}/${values.prefix}/catalogue.json.sig`,
  '--file', signaturePath, '--remote',
  '--content-type', 'text/plain',
  '--cache-control', cacheControl,
]);

upload([
  'r2', 'object', 'put', `${values.bucket}/${values.prefix}/catalogue.json`,
  '--file', manifestPath, '--remote',
  '--content-type', 'application/json',
  '--cache-control', cacheControl,
]);

// --- 6. Post-condition: fetch what was published and verify it -------------
// Publishing a catalogue nobody can verify would silently strand every user on
// their cached copy, so confirm from the public URL rather than trusting the
// upload's exit code.
console.log('==> Verifying the published catalogue');

const baseUrl = values['base-url']!;
const [publishedJson, publishedSig] = await Promise.all([
  fetch(`${baseUrl}/catalogue.json`, { cache: 'no-store' }).then((r) => r.text()),
  fetch(`${baseUrl}/catalogue.json.sig`, { cache: 'no-store' }).then((r) => r.text()),
]);

if (publishedJson !== bytes.toString('utf8')) {
  fail(
    `the catalogue at ${baseUrl} does not match what was just signed. It is most likely a cached copy of the previous revision — wait out the ${cacheControl} window and re-check before assuming the upload failed.`,
  );
}

if (publishedSig.trim() !== signature) {
  fail('the published signature does not match the one just produced.');
}

// Verify exactly as the app will, using the public half derived from the key
// that just signed. Catches a key/URL mismatch here rather than on users'
// machines, where the only symptom is a catalogue that silently never updates.
const publicKey = `10001,${privateKey.split(',')[1]}`;
if (!verifySignature(sha256Hex(Buffer.from(publishedJson, 'utf8')), publishedSig.trim(), publicKey)) {
  console.warn(
    '\nWarning: could not self-verify with the conventional public exponent (65537). This is expected only if the key was generated with a different exponent; confirm the app can still verify before relying on this publish.',
  );
}

console.log(`\nPublished revision ${manifest.revision}.`);
console.log('Commit the bumped revision and the .sig so the repo matches what is live.');
