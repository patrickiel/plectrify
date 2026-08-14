/**
 * Argument handling shared by the packaging scripts.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where a self-hosted content package is authored: `packaging/content/<id>`,
 * checked into the repo.
 *
 * These packages have no upstream to mirror — the patches and captures are the
 * author's own — so the repo is their source of truth. That is what makes a
 * rebuild reproducible and reviewable: the files that go into the archive are
 * versioned beside the catalogue entry that pins its hash, rather than scraped
 * out of whatever happened to be in `%APPDATA%` on the machine that ran the
 * script.
 */
export function contentDir(id: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'content', id);
}

/**
 * The script's own arguments, with pnpm's passthrough separator removed.
 *
 * `pnpm <script> -- --key x` forwards the literal `--` to the script, and
 * `parseArgs` treats `--` as end-of-options: everything after it becomes a
 * positional, so every flag is silently ignored and the script runs with its
 * defaults. That failure is quiet and looks like the flag "not working", so it
 * is stripped here once rather than rediscovered per script.
 *
 * Only a leading separator is dropped; a later `--` keeps its normal meaning.
 */
export function scriptArgs(argv: string[] = process.argv.slice(2)): string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

/**
 * Expands a leading `~` to the current user's home directory.
 *
 * PowerShell does not expand `~` when it passes an argument to a native
 * command, so `--out ~/.plectrify/x.key` arrives here literally and would create
 * a `~` folder in the working directory — inside the repo, which for a signing
 * key is the one place it must never be. Node has no built-in expansion, so it
 * is done here for every path a user can type.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/** The conventional name of the offline catalogue signing key. */
export const SIGNING_KEY_FILE = 'catalogue-signing.key';

/** The default home of the signing key: `~/.plectrify/catalogue-signing.key`.
 *  `homedir()` reads `%USERPROFILE%` on Windows and `$HOME` elsewhere, so no
 *  script ever names a user or a drive. */
export function defaultSigningKeyPath(): string {
  return join(homedir(), '.plectrify', SIGNING_KEY_FILE);
}

/**
 * Where the signing key is, and how that was decided.
 *
 * Precedence: an explicit flag, then `$PLECTRIFY_SIGNING_KEY`, then the default
 * path. The key is passed by path rather than by content on purpose — it must
 * stay offline, so there is deliberately no way to hand one to these scripts
 * through the repository or a CI secret store.
 *
 * `origin` is carried so a failure can say *which* of the three it tried; a
 * "key not found" naming only the path invites generating a second keypair,
 * which is the one mistake here that cannot be undone.
 */
export function resolveSigningKey(
  explicit: string | undefined,
  flag: string,
): { path: string; origin: string } {
  if (explicit) return { path: resolve(expandHome(explicit)), origin: flag };

  const fromEnv = process.env.PLECTRIFY_SIGNING_KEY;
  if (fromEnv) return { path: resolve(expandHome(fromEnv)), origin: '$PLECTRIFY_SIGNING_KEY' };

  return { path: defaultSigningKeyPath(), origin: 'the default location' };
}

/** The three places a key is looked for, in order — for error messages. */
export function signingKeySearchOrder(flag: string): string {
  return `  ${flag} <path>\n  $PLECTRIFY_SIGNING_KEY\n  ${defaultSigningKeyPath()}`;
}

/** The repository root, used to keep a generated key out of the working tree. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
