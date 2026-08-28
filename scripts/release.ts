/**
 * `pnpm release` and `pnpm release:build` — the release commands, on whichever
 * machine you are at.
 *
 * A release is three steps across two machines (RELEASING.md), and until now
 * each was a different command with a different flag: `release:windows
 * --pre-release`, then `release:macos`, then `release:windows --promote`.
 * Every one of those is unambiguous from where you are standing — there is
 * only one half of a release you *can* do on a given OS — so the flag was
 * asking you to restate what the machine already knew.
 *
 * So this dispatches on platform, exactly as run.ts does for `pnpm app`:
 *
 *   both      pnpm release:build     build and test locally, publishing nothing
 *   Windows   pnpm release           step 1 — build, tag, publish the pre-release
 *   macOS     pnpm release           step 2 — build, sign, upload the installer pkg
 *   Windows   pnpm release:promote   step 3 — flip the verified release to latest
 *
 * THE COMMANDS ARE NAMED FOR THE JOB, NOT FOR THE MACHINE. `release:windows`
 * and `release:macos` were the platform scripts wearing their file names, and
 * the name then said the one thing you did not need telling — you know which
 * box you are sitting at — while saying nothing about what the command did.
 * Worse, the pair had drifted into meaning *different steps*: `release:windows`
 * built locally and published nothing, `release:macos` built and uploaded. One
 * table row is now one command on both OSes, and the platform scripts are what
 * this file calls rather than what a maintainer types.
 *
 * Promotion stays a command of its own, and deliberately so: steps 1 and 2
 * produce artifacts, which is safe to repeat and cheap to redo while a version
 * is still a pre-release. Step 3 is the sign-off that you installed the build
 * and played through it, and it is irreversible — a promoted version is
 * immutable, because people may already hold its published checksums. Folding
 * it into `pnpm release` would let a command that means "build the thing"
 * quietly also mean "declare it good".
 *
 * run.ts used to say the release pipelines were deliberately NOT dispatched,
 * on the grounds that picking one silently would hide which half you were
 * doing. The concern was right and the remedy was the wrong one: the platform
 * *is* the half, so nothing is being picked. What was actually needed was for
 * the step to be announced rather than inferred, which is what the banner
 * below does.
 *
 * Every flag the platform scripts take still works and is forwarded untouched
 * (`--version` to double-check what you are shipping, `--skip-tests` to iterate
 * on packaging). Passing --promote or --pre-release explicitly is honoured
 * rather than overridden, so the older invocations in anyone's shell history
 * keep doing what they always did.
 */
const args = process.argv.slice(2);

/** `pnpm release:build` — consumed here; the platform scripts express it in
    their own vocabulary (see localFlags below). */
const local = args.includes('--local');

/** Opt back into Developer ID signing on the Mac once a membership exists;
    see macosFlags. Consumed here too — release.macos.ts knows only --ad-hoc. */
const developerId = args.includes('--developer-id');

const forwarded = args.filter((arg) => arg !== '--local' && arg !== '--developer-id');

/** Injected so the Windows script publishes rather than only building. A
    bare `release.windows.ts` packages an installer and stops, which is the
    right default for that script alone but not for the release command. */
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
 *
 * The local build then adds --no-upload, where Windows expresses the same thing
 * by *omitting* --pre-release. Both scripts publish nothing; only the polarity
 * of the switch differs, which is exactly what this dispatcher is for.
 */
function macosFlags(list: string[]): string[] {
  const signed = developerId
    || list.includes('--identity')
    || list.includes('--installer-identity')
    || list.some((arg) => arg.startsWith('--identity=') || arg.startsWith('--installer-identity='));
  const adHoc = !signed && !list.includes('--ad-hoc') ? ['--ad-hoc'] : [];
  const noUpload = local && !list.includes('--no-upload') ? ['--no-upload'] : [];
  return [...adHoc, ...noUpload, ...list];
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
  const flags = local ? forwarded : withPreRelease(forwarded);

  if (local) {
    announce('Build and test locally', 'Windows installer, publishing nothing');
    console.log('Install it and play through it before publishing anything.\n');
  } else if (flags.includes('--promote')) {
    announce('Release step 3 of 3', 'promoting the verified pre-release to latest');
  } else {
    announce('Release step 1 of 3', 'Windows installer + GitHub pre-release');
    console.log('Next: pnpm release on the Mac, at this same commit.\n');
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

  if (local) {
    announce('Build and test locally', `${what}, publishing nothing`);
    console.log('Install it and play through it before publishing anything.\n');
  } else {
    announce('Release step 2 of 3', what);
    console.log('Next: pnpm release:promote on Windows, once you have tested the build.\n');
  }

  await run('./release.macos.ts', flags);
} else {
  console.error('error: Plectrify releases from Windows and macOS only.');
  process.exit(1);
}
