/**
 * `pnpm release` — the release command, run by GitHub Actions and nowhere else.
 *
 * Releases are built on GitHub's runners (.github/workflows/release.yml and
 * promote.yml, RELEASING.md), never on a maintainer's machine: a local build
 * carries whatever that machine happens to have installed, and nothing records
 * what that was. This refuses to run outside Actions so a release can only ever
 * come from a clean runner at a tagged commit. Building and testing locally is
 * `pnpm app --dist`, which runs the same gates and publishes nothing.
 *
 * It dispatches on platform, exactly as run.ts does for `pnpm app`, because
 * each runner can only do its own half:
 *
 *   Windows   pnpm release             step 1 — build, tag, publish the pre-release
 *   macOS     pnpm release             step 2 — build, sign, upload the installer pkg
 *   Linux     pnpm release             step 2 — build, upload the .deb
 *   Windows   pnpm release --promote   step 3 — flip the verified release to latest
 *
 * Promotion stays a step of its own (its own workflow): steps 1 and 2 produce
 * artifacts, which is safe to repeat while a version is still a pre-release.
 * Step 3 is the sign-off that someone installed the build and played through
 * it, and it is irreversible — a promoted version is immutable, because people
 * may already hold its published checksums.
 *
 * Every flag the platform scripts take is forwarded untouched (`--version` to
 * double-check what is shipping).
 */
const args = process.argv.slice(2);

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.error('error: releases are built by GitHub Actions only (RELEASING.md).');
  console.error('       Run the Release workflow; to build and test locally, use pnpm app --dist.');
  process.exit(1);
}

/** Opt back into Developer ID signing on the Mac once a membership exists;
    see macosFlags. Consumed here too — release.macos.ts knows only --ad-hoc. */
const developerId = args.includes('--developer-id');

const forwarded = args.filter((arg) => arg !== '--developer-id');

/** Injected so the Windows script publishes rather than only building. A
    bare `release.windows.ts` packages an installer and stops. */
function withPreRelease(list: string[]): string[] {
  const publishing = list.includes('--pre-release') || list.includes('--promote');
  return publishing ? list : ['--pre-release', ...list];
}

/**
 * The mac flags, which differ from Windows in both directions.
 *
 * --ad-hoc is the DEFAULT rather than an escape hatch, because Plectrify has no
 * Apple Developer Program membership and will not have one for some time.
 * Developer ID signing and notarization both require the paid membership, so
 * the un-flagged command was one that could not complete on the only Mac that
 * builds this — it failed at the keychain gate before building anything. The
 * costs are unchanged and documented in release.macos.ts and RELEASING.md;
 * what changed is which of the two modes you have to ask for. `--developer-id`
 * is that ask, and is also what --identity/--installer-identity imply: naming a
 * certificate is not something you do by accident, and --ad-hoc refuses to be
 * combined with either.
 */
function macosFlags(list: string[]): string[] {
  const signed = developerId
    || list.includes('--identity')
    || list.includes('--installer-identity')
    || list.some((arg) => arg.startsWith('--identity=') || arg.startsWith('--installer-identity='));
  const adHoc = !signed && !list.includes('--ad-hoc') ? ['--ad-hoc'] : [];
  return [...adHoc, ...list];
}

function announce(step: string, what: string): void {
  console.log(`\n=== ${step}: ${what} ===\n`);
}

/** Run the platform script with the flags this dispatcher settled on.
    slice(0, 2) rather than argv[0]/argv[1]: under noUncheckedIndexedAccess an
    index is string | undefined, and the exec path and script path are exactly
    what we want to keep anyway. */
async function run(script: string, flags: string[]): Promise<void> {
  process.argv = [...process.argv.slice(0, 2), ...flags];
  await import(script);
}

if (process.platform === 'win32') {
  const flags = withPreRelease(forwarded);

  if (flags.includes('--promote')) {
    announce('Release step 3 of 3', 'promoting the verified pre-release to latest');
  } else {
    announce('Release step 1 of 3', 'Windows installer + GitHub pre-release');
    console.log('Next: the macOS and Linux jobs build at the tag this pushes.\n');
  }

  await run('./release.windows.ts', flags);
} else if (process.platform === 'darwin') {
  const flags = macosFlags(forwarded);

  // The banner names what this run will actually produce: ad-hoc publishes a
  // pkg whose bundles are ad-hoc signed but which is itself unsigned and not
  // notarized, and saying "notarized" there would be the one line of output
  // most worth trusting and least true.
  const what = flags.includes('--ad-hoc')
    ? 'macOS installer pkg, ad-hoc signed bundles (pkg unsigned, not notarized)'
    : 'signed, notarized macOS installer pkg';

  announce('Release step 2 of 3', what);
  console.log('Next: the Promote workflow, once every build is tested.\n');

  await run('./release.macos.ts', flags);
} else if (process.platform === 'linux') {
  announce('Release step 2 of 3', 'Linux .deb');
  console.log('Next: the Promote workflow, once every build is tested.\n');

  await run('./release.linux.ts', forwarded);
} else {
  console.error('error: Plectrify releases from Windows, macOS and Linux only.');
  process.exit(1);
}
