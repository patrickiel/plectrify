/**
 * Build a VST3 from its own permissively-licensed source and host the result —
 * the part of that job which is the same on every platform.
 *
 * WHAT IS SHARED. Provenance is: cloning at an exact tag and refusing anything
 * that is not one, recording every submodule SHA, pinning the VST3 SDK commit,
 * fetching iPlug2's prebuilt libraries, and running Steinberg's validator
 * against the artefact before it may be uploaded. None of that differs by
 * platform, and all of it is what makes a binary Plectrify *built* defensible
 * rather than merely convenient — so it lives once, here, where the rules
 * cannot drift apart.
 *
 * WHAT IS NOT. Compiling: MSBuild with a discovered toolset, or xcodebuild plus
 * a codesign. Those are in buildPlugin.windows.ts / buildPlugin.macos.ts, and
 * their quirks (an empty 32-bit bundle slot; an arm64 slice check) stay local to
 * them.
 *
 * THE OBLIGATION THIS CARRIES. Building makes Plectrify the producer of a binary
 * rather than its mirror, so the record has to be good enough for someone else
 * to reproduce it. Only ever build from a tag — a moving branch is not
 * provenance — and always pass --vst3-sdk: upstream's download-vst3-sdk.sh
 * clones the SDK from master and then deletes its .git, so without the pin a
 * rebuild silently compiles against different sources and upstream's own builds
 * cannot say which ones they used.
 *
 * NOT BIT-REPRODUCIBLE, on either platform: MSVC stamps a timestamp and PDB
 * signature into the PE; mac signatures and Mach-O UUIDs differ per build. So a
 * rehearsal cannot be promoted — the real run produces a different binary and
 * you must take that one's hash.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { scriptArgs } from './cli.ts';
import type { AssetPlatform } from './manifest.ts';
import { publishPlugin } from './publishPlugin.ts';

export const SCRIPT = 'build-plugin';

export function fail(message: string): never {
  console.error(`\n${SCRIPT}: ${message}`);
  process.exit(1);
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; inherit?: boolean } = {},
): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    stdio: options.inherit ? 'inherit' : 'pipe',
    // Long-running compiles produce a lot; the default 1 MB buffer truncates.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** What the platform half is handed once the source is pinned. */
export interface BuildPluginContext {
  id: string;
  version: string;
  /** Clean checkout at the exact tag. */
  repoDir: string;
  /** The pinned VST3 SDK inside it. */
  sdkDir: string;
  work: string;
  /** Where to leave the finished bundle. Already created. */
  staged: string;
  /** This platform's own flags, as parsed. */
  options: Record<string, string | boolean | undefined>;
  fail: (message: string) => never;
}

export interface BuildOutcome {
  /** The bundle's name inside `staged`, e.g. NeuralAmpModeler.vst3. */
  bundleName: string;
  /** The binary inside it, for the artefact record. */
  binaryPath: string;
  /** How it was compiled, in that toolchain's terms. Goes into PROVENANCE. */
  notes: string[];
}

export interface BuildPluginPlatform {
  platform: AssetPlatform;
  /** Flags beyond the shared ones. */
  options: NonNullable<ParseArgsConfig['options']>;
  /** Flags that must be present for this platform. */
  required: string[];
  /** Refuse before anything is cloned when this is the wrong machine. */
  requireHost: () => void;
  /** Which of iPlug2's prebuilt library sets to fetch ('win' | 'mac'). */
  prebuiltLibs: string;
  /** How to run bash — Git Bash on Windows, the system one elsewhere. */
  bash: () => string;
  /** cmake, for building the validator. */
  cmake: () => string;
  /** The validator binary, once the SDK build tree is configured and built. */
  validatorPath: (buildDir: string) => string | undefined;
  /** Compile and stage. */
  build: (context: BuildPluginContext) => Promise<BuildOutcome>;
}

export async function buildPlugin(impl: BuildPluginPlatform): Promise<void> {
  const { values } = parseArgs({
    args: scriptArgs(),
    options: {
      id: { type: 'string' },
      repo: { type: 'string' },
      /** A tag, never a branch: the pin has to name an immutable source. */
      tag: { type: 'string' },
      /** Defaults to the tag with a leading 'v' stripped. */
      version: { type: 'string' },
      /** Pin the VST3 SDK commit — reuse the one in the current PROVENANCE. */
      'vst3-sdk': { type: 'string' },
      work: { type: 'string', default: join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', 'plectrify-build') },
      bucket: { type: 'string', default: 'plectrify' },
      prefix: { type: 'string', default: 'plugins/v1/hosted' },
      'dry-run': { type: 'boolean', default: false },
      'no-upload': { type: 'boolean', default: false },
      /** Skip the conformance check. Iterating only — it always disables upload
       *  too, because the build is not bit-reproducible: "build, validate by
       *  hand, build again to upload" would publish a different binary from the
       *  one that was validated. */
      'no-validate': { type: 'boolean', default: false },
      ...impl.options,
    },
  });

  // The platform's own flags are spread in above, so they are not in the
  // inferred type; one cast, used wherever a flag is reached by name.
  const flags = values as Record<string, string | boolean | undefined>;

  for (const required of ['id', 'repo', 'tag', ...impl.required]) {
    if (!flags[required]) fail(`--${required} is required.`);
  }

  impl.requireHost();

  const version = (values.version as string | undefined) ?? (values.tag as string).replace(/^v/, '');
  const work = resolve(values.work as string);
  const repoDir = join(work, `${values.id}-${impl.platform}`);
  const noUpload = (values['no-upload'] as boolean) || (values['no-validate'] as boolean);

  if (values['dry-run']) {
    console.log(`Would clone ${values.repo} at ${values.tag} into ${repoDir} and build it.`);
    console.log('Nothing cloned, built or uploaded (--dry-run).');
    return;
  }

  // --- 1. Source, pinned to an exact tag -------------------------------------
  await mkdir(work, { recursive: true });
  if (existsSync(repoDir)) {
    fail(
      `${repoDir} already exists. Remove it (or pass --work elsewhere) so this builds from a clean checkout — a reused tree can silently carry stale objects into the artefact.`,
    );
  }

  console.log(`==> Cloning ${values.repo} at ${values.tag}`);
  // core.longpaths because these trees nest past MAX_PATH on Windows; without
  // it git aborts the checkout partway and leaves submodules unpopulated.
  const clone = run('git', [
    '-c', 'core.longpaths=true', 'clone', '--quiet',
    '--branch', values.tag as string, '--depth', '1', '--recursive',
    values.repo as string, repoDir,
  ]);
  if (!clone.ok) fail(`clone failed.\n${clone.output}`);

  const repoCommit = run('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).output.trim();
  const tagCommit = run('git', ['rev-parse', '--verify', `refs/tags/${values.tag}^{commit}`], {
    cwd: repoDir,
  });
  if (!tagCommit.ok || tagCommit.output.trim() !== repoCommit) {
    fail(
      `--tag ${values.tag} did not resolve to an exact tag at the checked-out commit. ` +
        'git clone --branch also accepts moving branch names, which are not release provenance.',
    );
  }

  const submodules = run('git', ['submodule', 'status', '--recursive'], { cwd: repoDir }).output;

  // --- 2. VST3 SDK, pinned ---------------------------------------------------
  const sdkDir = join(repoDir, 'iPlug2', 'Dependencies', 'IPlug', 'VST3_SDK');
  console.log('==> Cloning the VST3 SDK');
  // iPlug2 ships a non-empty VST3_SDK placeholder directory, so the clone has
  // to clear it first — upstream's download-vst3-sdk.sh opens with the same rm.
  // Confined to the checkout this script made, under --work.
  if (existsSync(sdkDir)) rmSync(sdkDir, { recursive: true, force: true });

  const sdkRef = values['vst3-sdk'] as string | undefined;
  const sdkClone = run('git', [
    'clone', '--quiet', 'https://github.com/steinbergmedia/vst3sdk.git',
    ...(sdkRef ? [] : ['--depth', '1']),
    '--branch', 'master', '--single-branch', sdkDir,
  ]);
  if (!sdkClone.ok) fail(`could not clone the VST3 SDK.\n${sdkClone.output}`);

  if (sdkRef) {
    const checkout = run('git', ['checkout', '--quiet', sdkRef], { cwd: sdkDir });
    if (!checkout.ok) fail(`the VST3 SDK has no commit ${sdkRef}.\n${checkout.output}`);
  }

  for (const module of ['pluginterfaces', 'base', 'public.sdk', 'cmake', 'vstgui4']) {
    const init = run('git', ['submodule', 'update', '--quiet', '--init', module], { cwd: sdkDir });
    if (!init.ok) fail(`could not init VST3 SDK submodule '${module}'.\n${init.output}`);
  }

  const sdkCommit = run('git', ['rev-parse', 'HEAD'], { cwd: sdkDir }).output.trim();
  const sdkCommitted = run('git', ['log', '-1', '--format=%cI'], { cwd: sdkDir }).output.trim();
  const sdkSubmodules = run('git', ['submodule', 'status'], { cwd: sdkDir }).output;

  // --- 3. Prebuilt dependencies ----------------------------------------------
  console.log('==> Downloading iPlug2 prebuilt libraries');
  const libs = run(impl.bash(), ['./download-prebuilt-libs.sh', impl.prebuiltLibs], {
    cwd: join(repoDir, 'iPlug2', 'Dependencies'),
  });
  if (!libs.ok) fail(`downloading the prebuilt libraries failed.\n${libs.output}`);

  // --- 4. Build (the platform's own business) --------------------------------
  const staged = join(work, `${values.id}-${impl.platform}-staged`);
  rmSync(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });

  const built = await impl.build({
    id: values.id as string,
    version,
    repoDir,
    sdkDir,
    work,
    staged,
    options: values as Record<string, string | boolean | undefined>,
    fail,
  });

  // --- 5. Validate before it can be uploaded ---------------------------------
  // Part of the pipeline rather than a step in a runbook, because the build is
  // not bit-reproducible. The only safe order is to validate this exact
  // artefact and upload it without rebuilding.
  if (values['no-validate']) {
    console.log('==> Skipping validation (--no-validate).');
  } else {
    const cmake = impl.cmake();
    const validatorBuild = join(work, `vst3-validator-${impl.platform}`);

    console.log('==> Building the VST3 validator');
    // We want one target out of this tree — the validator — and none of the SDK's
    // own example plug-ins. The flags matter more than they look:
    //
    //  - SMTG_ENABLE_VSTGUI_SUPPORT is the real option name. It used to be spelled
    //    SMTG_ADD_VSTGUI, which the SDK has not read for years: CMake reported it
    //    as an unused variable and built VSTGUI anyway. That is not cosmetic on
    //    macOS — VSTGUI drags in Objective-C++ sources, and the SDK's
    //    `project(vstsdk)` declares only C and CXX, so the generate step died on a
    //    missing CMAKE_OBJCXX_COMPILE_OBJECT.
    //  - The example plug-ins are the bulk of the build and are not wanted. The
    //    validator itself lives under public.sdk/samples/vst-hosting, which the
    //    SDK adds unconditionally, so turning the examples off does not lose it.
    //  - SMTG_CREATE_PLUGIN_LINK stops the SDK linking anything it builds into the
    //    host's real VST3 directory. Publishing a plugin must never install one.
    const configure = run(cmake, [
      '-S', sdkDir, '-B', validatorBuild,
      '-DSMTG_ENABLE_VSTGUI_SUPPORT=OFF',
      '-DSMTG_ENABLE_VST3_PLUGIN_EXAMPLES=OFF',
      '-DSMTG_CREATE_PLUGIN_LINK=OFF',
    ]);
    if (!configure.ok) fail(`could not configure the VST3 validator.\n${configure.output}`);

    const compiled = run(cmake, ['--build', validatorBuild, '--target', 'validator', '--config', 'Release']);
    if (!compiled.ok) fail(`could not build the VST3 validator.\n${compiled.output}`);

    const validator = impl.validatorPath(validatorBuild);
    if (!validator) fail('the validator did not appear under the SDK build tree.');

    console.log('==> Validating the built plugin');
    const validated = run(validator, [join(staged, built.bundleName)]);

    // Its exit status is the verdict, but the summary line is what a human
    // needs in the log when this fails at 2am.
    const summary = validated.output.match(/Result:.*/)?.[0] ?? '(no result line)';
    if (!validated.ok) {
      fail(
        `the built plugin failed VST3 validation — it is NOT fit to publish.\n${summary}\n\n${validated.output.slice(-4000)}`,
      );
    }
    console.log(`    ${summary}`);
  }

  // --- 6. Archive, record, upload --------------------------------------------
  await publishPlugin({
    script: SCRIPT,
    platform: impl.platform,
    id: values.id as string,
    version,
    staged,
    work,
    bucket: values.bucket as string,
    prefix: values.prefix as string,
    noUpload,
    noUploadReason: values['no-upload']
      ? '--no-upload'
      : '--no-validate always disables upload',
    provenance: () => [
      `Plugin:            ${values.id} ${version} (${impl.platform})`,
      `Built by:          Plectrify, from source (packaging/scripts/buildPlugin.${impl.platform.split('-')[0]}.ts)`,
      `Upstream project:  ${values.repo}`,
      `Upstream tag:      ${values.tag}`,
      `Upstream commit:   ${repoCommit}`,
      '',
      'WHY THIS IS BUILT RATHER THAN RE-HOSTED',
      '---------------------------------------',
      'Upstream publishes no binary for this platform and version, so there is no',
      'official build to mirror. Its source is permissively licensed, so the',
      'corresponding source is compiled here and the resulting VST3 is hosted by',
      'Plectrify. What is distributed is a binary we built under a licence that',
      'permits it — not somebody else\'s build we hold no grant for.',
      '',
      'SOURCE PINS',
      '-----------',
      submodules.trimEnd() || '(no submodules)',
      '',
      `VST3 SDK:          ${sdkCommit}`,
      `  committed:       ${sdkCommitted}`,
      `  pinned:          ${sdkRef ? 'yes, via --vst3-sdk' : 'NO — took master at build time'}`,
      sdkSubmodules.trimEnd(),
      '',
      'Upstream\'s own download-vst3-sdk.sh takes the SDK from master and then',
      'deletes its .git directory, so upstream builds cannot say which SDK they',
      'used. The commit above is this build\'s. Pass it as --vst3-sdk so a rebuild',
      'compiles the same sources rather than tracking master.',
      '',
      'THIS IS NOT A BIT-REPRODUCIBLE BUILD. Rebuilding from these exact pins',
      'yields an equivalent binary, not a byte-identical one. The archive hash',
      'below identifies this artefact — it is what the catalogue pins and what the',
      'app enforces on download — but it does not certify a deterministic build.',
      'To check a rebuild against this one, compare the compiled size and re-run',
      'the VST3 validator rather than expecting the hashes to match.',
      '',
      'BUILD',
      '-----',
      ...built.notes,
      '',
      `Binary sha256:     ${sha256File(built.binaryPath)}`,
      `Binary bytes:      ${statSync(built.binaryPath).size}`,
      `Validation:        ${
        values['no-validate']
          ? 'SKIPPED (--no-validate) — this artefact was not checked for VST3 conformance'
          : 'passed Steinberg\'s VST3 validator before upload'
      }`,
      '',
      'REPRODUCE',
      '---------',
      `  pnpm --dir packaging ${SCRIPT} -- --id ${values.id} \\`,
      `    --repo ${values.repo} --tag ${values.tag} --vst3-sdk ${sdkCommit}${impl.required
        .map((flag) => ` \\\n    --${flag} ${flags[flag]}`)
        .join('')}`,
      '',
      'Re-run on each upstream release rather than hand-editing the version or hash.',
      '',
    ],
    nextSteps:
      `Merge \`version\` and that whole ${impl.platform} asset into the existing\n` +
      'packaging/catalogue.json entry — url, sha256 and downloadBytes together, never one\n' +
      'without the others, and leave any other platform\'s asset alone. Build every platform\n' +
      'from the same tag before publishing: they share one `version`.\n\n' +
      '  pnpm --dir packaging validate -- --verify-assets   # re-download and re-hash what is live\n' +
      '  pnpm --dir packaging publish-catalogue\n\n' +
      'publish-catalogue bumps the revision itself; commit the bumped revision and the .sig.',
  });
}
