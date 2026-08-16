/**
 * The macOS half of `build-plugin`: compile the VST3 with xcodebuild.
 *
 * WHAT IS DIFFERENT FROM THE WINDOWS HALF:
 *  - xcodebuild drives the build (iPlug2 projects ship Xcode projects, not
 *    CMake). --project/--scheme name what to build; project layouts vary, so
 *    both are explicit rather than guessed.
 *  - The bundle must carry an arm64 slice — checked with `lipo`, because an
 *    x86_64-only plugin cannot load into the arm64-only Plectrify process.
 *  - The bundle is codesigned before archiving (ad-hoc unless --identity names
 *    a Developer ID). Plectrify's hardened runtime disables library validation,
 *    so ad-hoc-signed plugins load fine; a Developer ID signature is recorded
 *    in the provenance when used.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildOutcome, BuildPluginContext, BuildPluginPlatform } from './buildPlugin.ts';
import { fail, run } from './buildPlugin.ts';

export const macosBuild: BuildPluginPlatform = {
  platform: 'macos-arm64',

  options: {
    /** Path of the .xcodeproj relative to the repo, and the scheme to build.
     *  Explicit because project layouts differ per upstream. */
    project: { type: 'string' },
    scheme: { type: 'string' },
    /** Bundle the build emits, e.g. NeuralAmpModeler.vst3. */
    bundle: { type: 'string' },
    /** codesign identity; '-' (ad-hoc) unless a Developer ID is available. */
    identity: { type: 'string', default: '-' },
  },

  required: ['project', 'scheme', 'bundle'],

  requireHost: () => {
    if (process.platform !== 'darwin') {
      fail('this drives xcodebuild to produce a macOS VST3, so it only runs on a Mac.');
    }
  },

  prebuiltLibs: 'mac',

  bash: () => 'bash',

  cmake: () => 'cmake',

  validatorPath: (buildDir) =>
    ['bin/Release/validator', 'bin/validator'].map((rel) => join(buildDir, rel)).find(existsSync),

  build,
};

async function build(context: BuildPluginContext): Promise<BuildOutcome> {
  const bundleName = context.options.bundle as string;
  const identity = context.options.identity as string;
  const derived = join(context.work, `${context.id}-derived`);
  const products = join(derived, 'Products');

  console.log(`==> Building ${context.options.scheme} (arm64 Release)`);
  const built = run('xcodebuild', [
    '-project', join(context.repoDir, context.options.project as string),
    '-scheme', context.options.scheme as string,
    '-configuration', 'Release',
    '-derivedDataPath', derived,
    'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO',
    // -derivedDataPath is NOT enough to say where the product lands. iPlug2's
    // projects hard-set SYMROOT to '../build-mac' and CONFIGURATION_BUILD_DIR to
    // $(BUILD_DIR), so the bundle appeared next to the checkout while we looked
    // for it under the derived tree. Command-line settings outrank the project's,
    // so pin the output directory outright rather than guessing at either layout.
    `SYMROOT=${products}`, `CONFIGURATION_BUILD_DIR=${products}`,
    // ...and DEPLOYMENT_LOCATION=YES made every build *also* install the bundle
    // into $(VST3_PATH) — ~/Library/Audio/Plug-Ins/VST3, which on macOS is
    // Plectrify's own managed plugin directory. Publishing a plugin must not
    // install it: that left an unsigned build in the user's plugin folder with no
    // .plectrify-installed marker beside it, where the scanner would pick it up.
    'DEPLOYMENT_LOCATION=NO',
    // Signed properly below, once, after the bundle is final.
    'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO',
    'build',
  ]);
  if (!built.ok) fail(`xcodebuild failed.\n${built.output.slice(-6000)}`);

  const builtBundle = join(products, bundleName);
  if (!existsSync(builtBundle)) {
    fail(`the build produced no bundle at ${builtBundle}. Check --scheme/--bundle against the project.`);
  }

  const copy = run('cp', ['-R', builtBundle, join(context.staged, bundleName)]);
  if (!copy.ok) fail(`could not stage the bundle.\n${copy.output}`);

  const macosDir = join(context.staged, bundleName, 'Contents/MacOS');
  const binaryName = existsSync(macosDir) ? readdirSync(macosDir)[0] : undefined;
  if (!binaryName) fail(`${bundleName} has no Contents/MacOS binary.`);
  const binaryPath = join(macosDir, binaryName);

  const slices = run('lipo', ['-archs', binaryPath]).output.trim();
  if (!slices.split(/\s+/).includes('arm64')) {
    fail(
      `the built binary carries no arm64 slice (has: ${slices || 'none readable'}) — it cannot load into the arm64-only Plectrify process.`,
    );
  }

  console.log(`==> Codesigning the bundle (${identity === '-' ? 'ad-hoc' : identity})`);
  const sign = run('codesign', [
    '--force', '--timestamp', ...(identity === '-' ? ['--timestamp=none'] : []),
    '--sign', identity, join(context.staged, bundleName),
  ]);
  if (!sign.ok) fail(`codesign failed.\n${sign.output}`);

  return {
    bundleName,
    binaryPath,
    notes: [
      `Toolchain:         ${run('xcodebuild', ['-version']).output.trim().replace(/\n/g, ' ')}`,
      'Target:            arm64 Release (xcodebuild)',
      `Scheme:            ${context.options.scheme}`,
      `Slices:            ${slices}`,
      `Signature:         ${identity === '-' ? 'ad-hoc' : identity}`,
    ],
  };
}
