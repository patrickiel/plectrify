/**
 * Runs the pinned Wrangler CLI.
 *
 * Spawns Wrangler's JavaScript entry point with the current Node binary rather
 * than going through a shell. Two reasons, both learned the hard way:
 *
 *  - Shell quoting differs per platform, and arguments here legitimately
 *    contain spaces and commas (`--cache-control "public, max-age=300"`). Via
 *    `shell: true` on Windows those get re-split and Wrangler silently falls
 *    back to printing its help instead of failing loudly.
 *  - It sidesteps the `.cmd` shim entirely, so the same code path works on
 *    macOS, Linux and Windows.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packagingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function wranglerEntry(): string {
  // wrangler/package.json is always resolvable; its `bin` names the entry that
  // the .cmd shim would otherwise launch for us.
  const packageJsonPath = require.resolve('wrangler/package.json', { paths: [packagingDir] });
  const pkg = require(packageJsonPath) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;

  if (!bin) {
    throw new Error(
      'could not locate the Wrangler entry point. Run `pnpm install` in packaging/.',
    );
  }

  return resolve(dirname(packageJsonPath), bin);
}

export interface WranglerResult {
  ok: boolean;
  output: string;
}

/** Runs Wrangler and captures its output. */
export function wrangler(args: string[]): WranglerResult {
  const result = spawnSync(process.execPath, [wranglerEntry(), ...args], {
    encoding: 'utf8',
    cwd: packagingDir,
  });

  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Runs Wrangler with its output streamed straight through, for long uploads. */
export function wranglerInherit(args: string[]): boolean {
  const result = spawnSync(process.execPath, [wranglerEntry(), ...args], {
    stdio: 'inherit',
    cwd: packagingDir,
  });

  return result.status === 0;
}
