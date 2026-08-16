/**
 * Check that the published catalogue is one the shipped app will accept.
 *
 *   pnpm --dir packaging verify-live
 *
 * This closes the one gap the other checks cannot: publish.ts verifies with the
 * key that just signed, and the C++ unit tests verify the signature *format*,
 * but neither confirms that the public key actually compiled into Plectrify
 * matches the private key doing the signing. A mismatch there is silent and
 * total — every install would keep using its cached catalogue forever, with no
 * error the user or the publisher would ever see.
 *
 * So this reads the key out of the real source file, fetches the real published
 * URL, and verifies exactly as the app does.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scriptArgs } from './cli.ts';
import { R2_PUBLIC_BASE } from './pack.ts';
import { sha256Hex, verifySignature } from './signing.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    'base-url': {
      type: 'string',
      default: `${R2_PUBLIC_BASE}/plugins/v1`,
    },
    source: {
      type: 'string',
      default: resolve(repoRoot, 'Source/plugins/Catalogue.cpp'),
    },
  },
});

function fail(message: string): never {
  console.error(`\nverify-live: ${message}`);
  process.exit(1);
}

// --- The key the app was built with ----------------------------------------
const source = await readFile(resolve(values.source!), 'utf8');

// Matches the `constexpr const char* publicKey = "..." "...";` literal,
// including the multi-line concatenated form.
const match = source.match(/publicKey\s*=\s*((?:\s*"[^"]*")+)\s*;/);
if (!match) fail(`could not find catalogueSigningKey's publicKey in ${values.source}.`);

const publicKey = [...match[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');

if (!publicKey) {
  fail(
    'the app has no signing key compiled in, so it will refuse every published catalogue. Generate one with `pnpm --dir packaging keygen` and paste its public half into catalogueSigningKey().',
  );
}

// --- What is actually live --------------------------------------------------
console.log(`==> Fetching ${values['base-url']}`);

const [manifestResponse, signatureResponse] = await Promise.all([
  fetch(`${values['base-url']}/catalogue.json`, { cache: 'no-store' }),
  fetch(`${values['base-url']}/catalogue.json.sig`, { cache: 'no-store' }),
]);

if (!manifestResponse.ok) fail(`the manifest returned HTTP ${manifestResponse.status}.`);
if (!signatureResponse.ok) fail(`the signature returned HTTP ${signatureResponse.status}.`);

const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
const signature = (await signatureResponse.text()).trim();

// --- Verify exactly as the app does ----------------------------------------
if (!verifySignature(sha256Hex(manifestBytes), signature, publicKey)) {
  fail(
    'the published catalogue does NOT verify against the key compiled into the app. Every install would silently ignore it and keep its cached copy. Either the manifest was published with a different key, or the public half in Catalogue.cpp is stale.',
  );
}

const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  revision: number;
  packages: { id: string; kind: string }[];
  bundles?: { id: string }[];
};

const bundleCount = manifest.bundles?.length ?? 0;
// Reported by kind, because the point of this command is what the shipped key
// currently authorises to run inside Plectrify.
const pluginCount = manifest.packages.filter((p) => p.kind === 'plugin').length;
const contentCount = manifest.packages.length - pluginCount;
console.log(
  `\nLive catalogue verifies against the app's signing key: revision ${manifest.revision}, ` +
    `${pluginCount} plugins, ${contentCount} content, ${bundleCount} bundle${bundleCount === 1 ? '' : 's'}.`,
);
