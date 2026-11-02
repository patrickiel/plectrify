/**
 * The Linux update channel: a flat, signed APT repository published as assets
 * of the GitHub release itself, beside the .deb it indexes.
 *
 * WHY
 *
 * Double-clicking a newer .deb opens Ubuntu's App Center, which matches a local
 * package by name alone: with any version installed it greys the button out as
 * "Installed" and offers no upgrade. Nothing inside the package can change
 * that. So the package registers this repository instead (a sources entry and
 * the public key, both ordinary files of the .deb), and every later version
 * arrives through Software Updater / `apt upgrade` like any other package —
 * the way Chrome, VS Code and Signal ship on Linux.
 *
 * WHERE
 *
 *   https://github.com/<owner>/<repo>/releases/latest/download/
 *
 * apt fetches `InRelease`, `Packages` and the .deb from that base, and GitHub
 * redirects each to the release currently marked latest. That is the same
 * mechanism the download buttons use, with the same consequence: a
 * pre-release is invisible until promoted, so promotion stays the one switch
 * and needs no extra hosting, credentials or deploy. Promotion refuses a
 * release missing these files (release.windows.ts), because a latest release
 * without them would drop every Linux install off the channel.
 *
 * TRUST
 *
 * `InRelease` is clearsigned with the APT signing key, whose public half is
 * committed at APT_PUBLIC_KEY and shipped in the .deb; apt then checks
 * Release → Packages → the .deb by SHA-256. The private half is the
 * APT_SIGNING_KEY secret, scoped to the `apt-signing` environment of the
 * Release workflow (RELEASING.md). It is imported into a throwaway GNUPGHOME
 * and refused unless its fingerprint is the committed key's — a secret
 * replaced by mistake must not sign a repository every installed copy would
 * then reject.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ROOT, fail } from './shared.ts';

/** The committed public key: shipped in the .deb, and the fingerprint the
    signing secret must match. */
export const APT_PUBLIC_KEY = join(ROOT, 'Assets/linux/plectrify-archive-keyring.asc');

/** Where the .deb installs the key. apt reads armoured keys by their `.asc`
    extension (apt ≥ 2.4; the .deb's floor, Ubuntu 24.04, ships 2.7). */
export const APT_KEYRING_PATH = '/usr/share/keyrings/plectrify-archive-keyring.asc';

/** Where the .deb installs the sources entry. A plain package file, not a
    conffile: it goes with the package, and comes back with every upgrade. */
export const APT_SOURCES_PATH = '/etc/apt/sources.list.d/plectrify.sources';

/** The files a release must carry for the channel to work, by asset name. */
export const APT_REPOSITORY_FILES = ['Packages', 'Release', 'InRelease'] as const;

/** The deb822 sources entry. A flat repository: the suite is a path ending in
    `/` and there are no components. */
export function aptSourcesEntry(repoSlug: string): string {
  return `# Plectrify updates, installed by the plectrify package. Removing the package
# removes this file; see https://plectrify.com/docs/getting-started
Types: deb
URIs: https://github.com/${repoSlug}/releases/latest/download/
Suites: ./
Signed-By: ${APT_KEYRING_PATH}
`;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Write `Packages` and `Release` for the one .deb into `outDir`. The .deb is
 * referenced by its bare name, so apt resolves it against the same base URL
 * and lands on the asset of the same release.
 */
export function writeAptIndex(debPath: string, outDir: string): void {
  const control = spawnSync('dpkg-deb', ['--field', debPath], { encoding: 'utf8' });
  if (control.status !== 0) fail(`could not read the control fields of ${debPath}.`);
  const paragraph = control.stdout.trimEnd();
  const packages = `${paragraph}
Filename: ./${basename(debPath)}
Size: ${statSync(debPath).size}
SHA256: ${sha256(debPath)}
`;
  const packagesPath = join(outDir, 'Packages');
  writeFileSync(packagesPath, packages, 'utf8');

  // No Suite/Codename: a flat repository is addressed by path, and a codename
  // apt has seen would make it ask the user to confirm any later change.
  const release = `Origin: Plectrify
Label: Plectrify
Architectures: amd64
Date: ${new Date().toUTCString()}
Description: Plectrify releases
SHA256:
 ${sha256(packagesPath)} ${statSync(packagesPath).size} Packages
`;
  writeFileSync(join(outDir, 'Release'), release, 'utf8');
}

function gpg(home: string, args: string[]): string {
  const result = spawnSync('gpg', ['--batch', '--no-tty', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GNUPGHOME: home },
  });
  if (result.status !== 0) fail(`gpg ${args[0]} failed:\n${result.stderr}`);
  return result.stdout;
}

function fingerprints(colons: string): string[] {
  return colons
    .split('\n')
    .filter((line) => line.startsWith('fpr:'))
    .map((line) => line.split(':')[9] ?? '');
}

/**
 * Clearsign `<outDir>/Release` into `<outDir>/InRelease` with the armoured
 * private key in `armoredKey`, which must be the committed public key's.
 */
export function signAptRelease(outDir: string, armoredKey: string): void {
  const home = mkdtempSync(join(tmpdir(), 'plectrify-apt-'));
  try {
    const expected = fingerprints(
      gpg(home, ['--with-colons', '--import-options', 'show-only', '--import', APT_PUBLIC_KEY]),
    )[0];
    if (!expected) fail(`${APT_PUBLIC_KEY} holds no public key.`);

    const keyFile = join(home, 'signing.asc');
    writeFileSync(keyFile, armoredKey, { mode: 0o600 });
    gpg(home, ['--import', keyFile]);
    rmSync(keyFile);
    const available = fingerprints(gpg(home, ['--with-colons', '--list-secret-keys']));
    if (!available.includes(expected)) {
      fail(
        `APT_SIGNING_KEY is not the key committed at ${APT_PUBLIC_KEY} (expected ${expected}). ` +
          'Every installed copy trusts that key alone; refusing to sign with another.',
      );
    }

    gpg(home, [
      '--yes', '--local-user', expected, '--digest-algo', 'SHA512',
      '--clearsign', '--output', join(outDir, 'InRelease'), join(outDir, 'Release'),
    ]);
    gpg(home, ['--verify', join(outDir, 'InRelease')]);
  } finally {
    spawnSync('gpgconf', ['--kill', 'all'], { env: { ...process.env, GNUPGHOME: home } });
    rmSync(home, { recursive: true, force: true });
  }
}
