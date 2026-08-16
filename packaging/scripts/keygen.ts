/**
 * Generate the catalogue manifest signing keypair. Run once.
 *
 *   pnpm --dir packaging keygen
 *
 * Writes to ~/.plectrify/catalogue-signing.key — the same path publish-catalogue
 * reads, so the two agree by construction rather than by a pasted argument.
 * $PLECTRIFY_SIGNING_KEY or --out override it, and a key inside the repository is
 * refused outright.
 *
 * ROTATION. catalogueSigningKey() in Catalogue.cpp is a plain
 * constant, so a replacement key can ship in a release before the old one is
 * retired: publish a build that accepts both, wait for adoption, then drop the
 * old one. Replacing the key outright would leave every already-installed build
 * unable to verify the catalogue.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot, resolveSigningKey, scriptArgs } from './cli.ts';
import { generateKeyPair } from './signing.ts';

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    out: { type: 'string' },
    bits: { type: 'string', default: '2048' },
  },
});

const { path: keyPath, origin } = resolveSigningKey(values.out, '--out');

// A key inside the working tree is one `git add .` from being published to the
// world, and signing authority over the catalogue is code-execution authority
// on every install. Worth refusing rather than warning about — a literal `~`
// from PowerShell used to land one here.
const inRepo = relative(repoRoot(), keyPath);
if (inRepo && !inRepo.startsWith('..') && !/^[A-Za-z]:/.test(inRepo)) {
  console.error(`Refusing to write a signing key inside the repository (${keyPath}).`);
  console.error('Choose a path outside it — the key must never be committed.');
  process.exit(1);
}

// Overwriting is never what someone means here, and the consequence is severe:
// every shipped build verifies against the old public key, so replacing the
// private half silently breaks catalogue updates for existing installs.
if (existsSync(keyPath)) {
  console.error(`Refusing to overwrite the existing key at ${keyPath}.`);
  console.error(
    'Replacing a signing key invalidates every shipped build’s ability to verify the catalogue. To rotate, add the new public key alongside the old one in a release first.',
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPair(Number(values.bits));

await mkdir(dirname(keyPath), { recursive: true });
await writeFile(keyPath, privateKey, { encoding: 'ascii', mode: 0o600 });

console.log(`Private key written to ${keyPath} (from ${origin}).`);
console.log('Keep it offline, and back it up: it is the only way to publish a');
console.log('catalogue update that existing installs will accept. Do not commit');
console.log('it, and do not put it in CI.\n');
console.log('Paste this into catalogueSigningKey() in Source/plugins/Catalogue.cpp:');
console.log(`    constexpr const char* publicKey = "${publicKey}";`);
