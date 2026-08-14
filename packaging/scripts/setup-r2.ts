/**
 * Provision the Cloudflare R2 bucket that serves the plugin catalogue.
 *
 *   pnpm --dir packaging setup-r2 -- --dry-run
 *   pnpm --dir packaging setup-r2 -- --domain cdn.plectrify.com --zone-id <id>
 *
 * Idempotent: every step checks for the resource before creating it, so this is
 * safe to re-run and safe to hand to someone setting up a fork. It creates
 * nothing outside the named bucket.
 *
 * The bucket is named for the product, not for what is in it. It holds the
 * plugin catalogue under `plugins/v1/` today, and anything else public later
 * gets a prefix of its own rather than a bucket of its own — the name is
 * invisible to users now that a custom domain fronts it, so there is no reason
 * for it to describe one tenant. (It was `rigflow-plugins` before the rename;
 * R2 cannot rename a bucket, so that one was replaced rather than renamed.)
 *
 * WHAT IS PUBLIC. Everything in this bucket is world-readable — that is the
 * point, Plectrify fetches it unauthenticated. Never put anything here that is
 * not meant to be public, and above all never the signing key: it lives offline
 * and the bucket only ever holds signatures it produced.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scriptArgs } from './cli.ts';
import { wrangler } from './wrangler.ts';

const packagingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    bucket: { type: 'string', default: 'plectrify' },
    // The custom domain, and the zone it belongs to — which must be in this
    // Cloudflare account. Optional only so a fork with no domain of its own can
    // still get a working bucket; Plectrify's own is cdn.plectrify.com, the
    // address R2_PUBLIC_BASE and PLECTRIFY_CATALOGUE_URL both name.
    //
    // A custom domain rather than the bucket's r2.dev URL: that one is rate
    // limited, Cloudflare positions it as a development convenience, and it
    // names the *bucket*, so it cannot survive the bucket being replaced —
    // which is exactly what the RigFlow rename required.
    domain: { type: 'string' },
    // Wrangler requires this alongside --domain and will not look it up. Find
    // it on the zone's dashboard overview, or:
    //   curl -H "Authorization: Bearer <token>" \
    //     "https://api.cloudflare.com/client/v4/zones?name=plectrify.com"
    'zone-id': { type: 'string' },
    // TLS floor for the custom domain. Wrangler defaults to 1.0, which is long
    // dead; nothing that can run Plectrify is short of 1.2.
    'min-tls': { type: 'string', default: '1.2' },
    // Incomplete multipart uploads are invisible, billable, and never referenced
    // by a catalogue — a failed upload of a plugin archive leaves one behind.
    // Nothing whole is ever expired: every object here is pinned by a hash in a
    // published manifest, so deleting one on a timer would break installs.
    'abort-multipart-days': { type: 'string', default: '7' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`\nR2 setup: ${message}`);
  process.exit(1);
}

console.log('==> Checking Wrangler authentication');
const who = wrangler(['whoami']);
if (!who.ok) {
  fail(`wrangler could not authenticate. Run:\n  pnpm --dir packaging exec wrangler login\n\n${who.output}`);
}

// --- Bucket ----------------------------------------------------------------
console.log(`==> Ensuring bucket '${values.bucket}'`);
const list = wrangler(['r2', 'bucket', 'list']);
if (!list.ok) fail(`could not list R2 buckets.\n${list.output}`);

const exists = new RegExp(`^name:\\s+${values.bucket}\\s*$`, 'm').test(list.output);

if (exists) {
  console.log('    already exists');
} else if (values['dry-run']) {
  console.log('    would create it (--dry-run)');
} else {
  const created = wrangler(['r2', 'bucket', 'create', values.bucket!]);
  if (!created.ok) fail(`could not create the bucket.\n${created.output}`);
  console.log('    created');
}

// --- Public access ---------------------------------------------------------
// The custom domain is the *only* public address, and attaching it is what makes
// the bucket readable. The r2.dev dev URL is deliberately left disabled: it is a
// second public address for the same objects that nothing is ever pointed at,
// and one address is one thing to keep true. A fork with no domain can enable it
// by hand (`wrangler r2 bucket dev-url enable`) and set PLECTRIFY_CATALOGUE_URL
// to what that prints.
let publicUrl: string | undefined;

if (values.domain) {
  if (!values['zone-id']) fail('--domain also needs --zone-id (see the option comment).');

  console.log(`==> Ensuring custom domain '${values.domain}'`);
  const domains = wrangler(['r2', 'bucket', 'domain', 'list', values.bucket!]);

  if (domains.output.includes(values.domain)) {
    console.log('    already attached');
  } else if (values['dry-run']) {
    console.log('    would attach it (--dry-run)');
  } else {
    const added = wrangler([
      'r2', 'bucket', 'domain', 'add', values.bucket!,
      '--domain', values.domain,
      '--zone-id', values['zone-id']!,
      '--min-tls', values['min-tls']!,
      '--force',
    ]);
    if (!added.ok) {
      fail(`could not attach '${values.domain}'. The zone must be in this Cloudflare account.\n${added.output}`);
    }
    console.log('    attached');
  }

  publicUrl = `https://${values.domain}`;
} else {
  console.log('==> No --domain given; the bucket stays private.');
}

// --- Lifecycle -------------------------------------------------------------
console.log('==> Ensuring the stale-multipart rule');
const ruleName = 'abort-stale-multipart';
const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', values.bucket!]);

if (rules.output.includes(ruleName)) {
  console.log('    already set');
} else if (values['dry-run']) {
  console.log('    would add it (--dry-run)');
} else {
  const added = wrangler([
    'r2', 'bucket', 'lifecycle', 'add', values.bucket!, ruleName, '',
    '--abort-multipart-days', values['abort-multipart-days']!, '--force',
  ]);
  if (!added.ok) fail(`could not add the lifecycle rule.\n${added.output}`);
  console.log('    added');
}

if (values['dry-run']) {
  console.log('\nNothing was changed (--dry-run).');
  process.exit(0);
}

// --- Report ----------------------------------------------------------------
if (!publicUrl) {
  console.log('\nBucket ready, but private — nothing can fetch the catalogue from it.');
  console.log('Re-run with --domain and --zone-id, or enable the dev URL by hand:');
  console.log(`    pnpm --dir packaging exec wrangler r2 bucket dev-url enable ${values.bucket}`);
  process.exit(0);
}

const baseUrl = `${publicUrl}/plugins/v1`;

console.log('\nBucket ready.');
console.log(`  Catalogue base URL: ${baseUrl}\n`);
console.log('The app must be built pointing at it. CMakeLists.txt already defaults');
console.log('to this; to point a build elsewhere:');
console.log(`    cmake -B build -DPLECTRIFY_CATALOGUE_URL=${baseUrl}\n`);
console.log('Next, once: generate the signing key, paste its public half into');
console.log('catalogueSigningKey(), then publish:');
console.log('    pnpm --dir packaging keygen');
console.log('    pnpm --dir packaging publish-catalogue');
