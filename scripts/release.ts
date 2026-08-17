/**
 * `pnpm release` — the one release command, on whichever machine you are at.
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
 *   Windows   pnpm release           step 1 — build, tag, publish the pre-release
 *   macOS     pnpm release           step 2 — build, sign, notarize, upload the installer pkg
 *   Windows   pnpm release:promote   step 3 — flip the verified release to latest
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
 * (`pnpm release --no-upload` to rehearse on the Mac, `--version` to
 * double-check what you are shipping). Passing --promote or --pre-release
 * explicitly is honoured rather than overridden, so the older invocations in
 * anyone's shell history keep doing what they always did.
 */
const args = process.argv.slice(2);

/** Injected so the Windows script publishes rather than only building. A
    bare `release.windows.ts` packages an installer and stops, which is the
    right default for that script alone but not for the release command. */
function withPreRelease(): string[] {
  const publishing = args.includes('--pre-release') || args.includes('--promote');
  return publishing ? args : ['--pre-release', ...args];
}

function announce(step: string, what: string): void {
  console.log(`\n=== ${step}: ${what} ===\n`);
}

if (process.platform === 'win32') {
  const forwarded = withPreRelease();

  if (forwarded.includes('--promote')) {
    announce('Release step 3 of 3', 'promoting the verified pre-release to latest');
  } else {
    announce('Release step 1 of 3', 'Windows installer + GitHub pre-release');
    console.log('Next: pnpm release on the Mac, at this same commit.\n');
  }

  // slice(0, 2) rather than argv[0]/argv[1]: under noUncheckedIndexedAccess an
  // index is string | undefined, and the exec path and script path are exactly
  // what we want to keep anyway.
  process.argv = [...process.argv.slice(0, 2), ...forwarded];
  await import('./release.windows.ts');
} else if (process.platform === 'darwin') {
  // The banner names what this run will actually produce: --ad-hoc publishes a
  // pkg whose bundles are ad-hoc signed but which is itself unsigned and not
  // notarized, and saying "notarized" there would be the one line of output
  // most worth trusting and least true.
  announce(
    'Release step 2 of 3',
    args.includes('--ad-hoc')
      ? 'macOS installer pkg, ad-hoc signed bundles (pkg unsigned, not notarized)'
      : 'signed, notarized macOS installer pkg',
  );
  console.log('Next: pnpm release:promote on Windows, once you have tested the build.\n');

  await import('./release.macos.ts');
} else {
  console.error('error: Plectrify releases from Windows and macOS only.');
  process.exit(1);
}
