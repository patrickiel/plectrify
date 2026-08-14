/**
 * Re-host a plugin whose upstream release cannot be unzipped to a VST3 — the
 * part of that job which is the same everywhere.
 *
 * Every catalogue asset must yield a .vst3 by unzipping alone; the app will not
 * download and run a third-party installer on a user's behalf. A few projects
 * ship only an installer (on macOS, most of them ship a .dmg or .pkg), so for
 * those the bundle is extracted once, here, and re-hosted by Plectrify. That is
 * only permissible for licences that allow redistributing the binary; and
 * `validate` refuses a self-hosted copyleft plugin with no published source.
 *
 * WHAT IS SHARED AND WHAT IS NOT. Pinning the upstream download, staging,
 * archiving, provenance, upload and the printed catalogue asset are one flow
 * with no platform in them. Getting the bundle out of the payload is entirely
 * platform-specific and lives in hostPlugin.windows.ts / hostPlugin.macos.ts,
 * because the two have nothing in common but their purpose: the Windows route
 * genuinely installs software on this machine and must put it back afterwards,
 * while the macOS route mounts a disk image and copies files, executing
 * nothing. Those belong in separate files a reader opens deliberately.
 *
 * `host-plugin.ts` picks the one matching the machine. Neither is a variant of
 * the other, and the platform is never a choice — only a fact about where you
 * are standing.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { scriptArgs } from './cli.ts';
import type { AssetPlatform } from './manifest.ts';
import { publishPlugin } from './publishPlugin.ts';

export const SCRIPT = 'host-plugin';

export function fail(message: string): never {
  console.error(`\n${SCRIPT}: ${message}`);
  process.exit(1);
}

/** What the platform half is handed. */
export interface HostPluginContext {
  id: string;
  version: string;
  /** The pinned upstream download, already verified against --sha256. */
  url: string;
  payloadPath: string;
  payloadName: string;
  payloadHash: string;
  /** Scratch space; already created and empty. */
  work: string;
  /** Where to leave what should be archived. Already created. */
  staged: string;
  /** This platform's own flags, as parsed. An array is a repeatable one. */
  options: Record<string, string | string[] | boolean | undefined>;
  dryRun: boolean;
  fail: (message: string) => never;
}

export interface Extraction {
  /** What was taken out of the payload, named for the record. */
  collected: string[];
  /** How, in the terms that platform's reader needs. Goes into PROVENANCE. */
  notes: string[];
}

export interface HostPluginPlatform {
  /** The catalogue slug this produces an asset for. */
  platform: AssetPlatform;
  /** Flags beyond the shared ones. */
  options: NonNullable<ParseArgsConfig['options']>;
  /** Refuse before anything is downloaded when this is the wrong machine. */
  requireHost: () => void;
  /** Put the bundle(s) into `staged`. Return null to stop for --dry-run. */
  extract: (context: HostPluginContext) => Promise<Extraction | null>;
}

export async function hostPlugin(impl: HostPluginPlatform): Promise<void> {
  const { values } = parseArgs({
    args: scriptArgs(),
    options: {
      id: { type: 'string' },
      version: { type: 'string' },
      /** The upstream download this extraction is pinned to. */
      url: { type: 'string' },
      sha256: { type: 'string' },
      bucket: { type: 'string', default: 'plectrify' },
      prefix: { type: 'string', default: 'plugins/v1/hosted' },
      'dry-run': { type: 'boolean', default: false },
      'no-upload': { type: 'boolean', default: false },
      ...impl.options,
    },
  });

  for (const required of ['id', 'version', 'url', 'sha256'] as const) {
    if (!values[required]) fail(`--${required} is required.`);
  }

  // Before the download, so the wrong machine costs nothing.
  impl.requireHost();

  const work = join(tmpdir(), `plectrify-${SCRIPT}-${values.id}-${impl.platform}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  // --- Fetch the upstream asset and check it is the one we pinned ------------
  console.log(`==> Downloading ${values.url}`);
  const response = await fetch(values.url as string);
  if (!response.ok) fail(`upstream returned HTTP ${response.status}.`);

  const payload = Buffer.from(await response.arrayBuffer());
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  if (payloadHash !== (values.sha256 as string).toLowerCase()) {
    fail(
      `the upstream asset hashed ${payloadHash} but --sha256 says ${values.sha256}. Upstream re-cut the release; confirm what changed before re-hosting it.`,
    );
  }

  const payloadName = basename(new URL(values.url as string).pathname);
  const payloadPath = join(work, payloadName);
  await writeFile(payloadPath, payload);

  const staged = join(work, 'staged');
  await mkdir(staged, { recursive: true });

  const extraction = await impl.extract({
    id: values.id as string,
    version: values.version as string,
    url: values.url as string,
    payloadPath,
    payloadName,
    payloadHash,
    work,
    staged,
    options: values as Record<string, string | string[] | boolean | undefined>,
    dryRun: values['dry-run'] as boolean,
    fail,
  });

  if (extraction === null) {
    console.log('\nNothing extracted or uploaded (--dry-run).');
    return;
  }

  if (extraction.collected.length === 0) fail('nothing was extracted from the payload.');
  console.log(`==> Collected: ${extraction.collected.join(', ')}`);

  await publishPlugin({
    script: SCRIPT,
    platform: impl.platform,
    id: values.id as string,
    version: values.version as string,
    staged,
    work,
    bucket: values.bucket as string,
    prefix: values.prefix as string,
    noUpload: values['no-upload'] as boolean,
    provenance: () => [
      `Plugin:            ${values.id} ${values.version} (${impl.platform})`,
      `Hosted by:         Plectrify (packaging/scripts/hostPlugin.${impl.platform.split('-')[0]}.ts)`,
      `Upstream release:  ${values.url}`,
      `Upstream sha256:   ${payloadHash}`,
      '',
      'WHY THIS IS RE-HOSTED',
      '---------------------',
      'Every Plectrify catalogue asset must yield a .vst3 by unzipping alone: the',
      'app will not run a third-party installer on a user\'s behalf. Upstream ships',
      'this build in a form that fails that bar, so the bundle was extracted once',
      'here and re-zipped unmodified. Redistribution is permitted by this plugin\'s',
      'licence; see the catalogue entry.',
      '',
      ...extraction.notes,
      '',
      `Extracted:         ${extraction.collected.join(', ')}`,
      '',
      'REPRODUCE',
      '---------',
      `  pnpm --dir packaging ${SCRIPT} -- --id ${values.id} --version ${values.version} \\`,
      `    --url ${values.url} --sha256 ${payloadHash}`,
      '',
    ],
    nextSteps:
      'Merge that into the package\'s entry in packaging/catalogue.json — selfHosted is on\n' +
      'the asset, because it is only this platform we now serve — and leave every other\n' +
      'platform\'s asset alone: the shared `version` has to describe all of them, so publish\n' +
      'a platform only when its build is from the same release.\n\n' +
      '  pnpm --dir packaging validate -- --verify-assets\n' +
      '  pnpm --dir packaging publish-catalogue',
  });
}
