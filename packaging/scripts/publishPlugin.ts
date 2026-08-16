/**
 * The tail every plugin-hosting script shares: archive the staged bundle, write
 * its provenance, upload both, and print the catalogue asset to merge.
 *
 * WHY IT IS SHARED. Re-hosting and building, on Windows and on macOS, are four
 * different ways of *obtaining* a VST3 and exactly one way of publishing it.
 * Keeping that one way in one place is what stops the four from drifting — and
 * they had: the two Windows scripts still zipped with PowerShell's
 * Compress-Archive (backslash entry names, live timestamps) while the two mac
 * ones used pack.ts's reproducible zipper, so the same bundle published from
 * the two machines could not even be compared. Everything now goes through
 * `buildArchive`.
 *
 * NAMING IS BY PLATFORM SLUG, the same string the catalogue keys the asset by:
 * `<id>-<version>-<slug>.zip` beside `PROVENANCE-<slug>.txt`. No platform's
 * artefact is the unsuffixed one.
 */
import { rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetPlatform } from './manifest.ts';
import { R2_PUBLIC_BASE, buildArchive, fail, type PackResult } from './pack.ts';
import { wranglerInherit } from './wrangler.ts';

export interface PublishedPlugin extends PackResult {
  archiveName: string;
}

export interface PublishPluginOptions {
  /** The invoking script, for error messages. */
  script: string;
  platform: AssetPlatform;
  id: string;
  version: string;
  /** Directory whose entire contents become the archive. */
  staged: string;
  /** Scratch directory; the archive is written here. */
  work: string;
  bucket: string;
  prefix: string;
  /** Skip the upload, e.g. --no-upload or a rehearsal. */
  noUpload: boolean;
  /** Printed instead of the upload, so the reason is never a mystery. */
  noUploadReason?: string;
  /** The provenance record, given the finished archive — callers need its hash
   *  and size, so this is a callback rather than a string. Everything specific
   *  to how the binary was obtained belongs here; the artefact block below is
   *  appended for every caller. */
  provenance: (published: PublishedPlugin) => string[];
  /** What the author should do with the printed asset. */
  nextSteps: string;
}

/** Archive, record, upload, and print the catalogue asset. Returns what was
    published so a caller can say more about it. */
export async function publishPlugin(options: PublishPluginOptions): Promise<PublishedPlugin> {
  const pack = buildArchive({
    script: options.script,
    staged: options.staged,
    work: join(options.work, `${options.id}-${options.platform}-out`),
  });

  const archiveName = `${options.id}-${options.version}-${options.platform}.zip`;
  const archivePath = join(options.work, archiveName);
  rmSync(archivePath, { force: true });
  await rename(pack.archivePath, archivePath);

  const published: PublishedPlugin = { ...pack, archivePath, archiveName };

  const provenanceName = `PROVENANCE-${options.platform}.txt`;
  const provenancePath = join(options.work, provenanceName);
  await writeFile(
    provenancePath,
    [
      ...options.provenance(published),
      'ARTEFACT',
      '--------',
      `Hosted archive:    ${archiveName}`,
      `Archive sha256:    ${published.sha256}`,
      `Archive bytes:     ${published.downloadBytes}`,
      '',
      'The archive is built by packaging/scripts/pack.ts, the one zipper every',
      'Plectrify package goes through: sorted forward-slash entries, each stamped to',
      'a fixed date, one compression level. So two archives of the same bundle',
      'compare byte-for-byte whichever machine built them — which says nothing',
      'about the bundle inside being reproducible; see above for that.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`\n==> Archive: ${archivePath}`);
  console.log(`    sha256:  ${published.sha256}`);
  console.log(`    bytes:   ${published.downloadBytes}`);

  const keyPrefix = `${options.prefix}/${options.id}`;

  if (options.noUpload) {
    console.log(`\nNot uploaded (${options.noUploadReason ?? '--no-upload'}).`);
  } else {
    console.log(`==> Uploading to r2://${options.bucket}/${keyPrefix}`);
    // Immutable: the archive name carries the version and the platform, so a
    // new build is a new object rather than a mutation of this one. The
    // provenance beside it is short-lived, because it is a description of
    // whatever is current rather than something a hash is pinned to.
    upload(options, `${keyPrefix}/${archiveName}`, archivePath, 'application/zip', 'public, max-age=31536000, immutable');
    upload(options, `${keyPrefix}/${provenanceName}`, provenancePath, 'text/plain', 'public, max-age=300');
  }

  console.log('\nAsset for the catalogue entry (merge beside its other platforms):\n');
  console.log(
    JSON.stringify(
      {
        assets: {
          [options.platform]: {
            url: `${R2_PUBLIC_BASE}/${keyPrefix}/${archiveName}`,
            sha256: published.sha256,
            downloadBytes: published.downloadBytes,
            // We are the ones serving this url, so the asset says so. Printed
            // rather than left to the author because `validate` checks the flag
            // against the url, and the two only ever disagree by accident.
            selfHosted: true,
          },
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n${options.nextSteps}`);

  return published;
}

function upload(
  options: PublishPluginOptions,
  key: string,
  file: string,
  contentType: string,
  cacheControl: string,
): void {
  if (
    !wranglerInherit([
      'r2', 'object', 'put', `${options.bucket}/${key}`,
      '--file', file, '--remote',
      '--content-type', contentType,
      '--cache-control', cacheControl,
    ])
  ) {
    fail(options.script, `uploading ${key} failed.`);
  }
}
