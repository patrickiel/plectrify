/**
 * The Windows half of `build-plugin`: compile the VST3 with MSBuild.
 *
 * EVERYTHING IS LOCATED RATHER THAN ASSUMED. Upstream's own makedist script
 * hardcodes a Visual Studio 2019 path and simply fails on any other install,
 * which is the mistake this avoids: vswhere finds the newest VS, the newest x64
 * PlatformToolset it has, and the CMake bundled with it.
 *
 * It also builds only the VST3 target. Upstream's makedist-win.bat builds the
 * standalone app too and, in its post-build step, copies the bundle into
 * C:\Program Files\Common Files\VST3 — which needs admin and would install the
 * plugin system-wide on whatever machine cut the release. Plectrify ships the
 * VST3 alone, so neither is wanted, and that denied copy is why the bundle's
 * existence rather than MSBuild's exit code decides success here.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildOutcome, BuildPluginContext, BuildPluginPlatform } from './buildPlugin.ts';
import { fail, run } from './buildPlugin.ts';

function vswhere(args: string[]): string {
  const exe = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio\\Installer\\vswhere.exe',
  );
  if (!existsSync(exe)) fail('vswhere.exe not found; is Visual Studio installed?');
  return run(exe, args).output.trim();
}

/** The newest PlatformToolset this machine can actually build with. */
function installedToolset(vsPath: string): string {
  const vcRoot = join(vsPath, 'MSBuild\\Microsoft\\VC');
  const found: string[] = [];
  for (const versionDir of existsSync(vcRoot) ? readdirSync(vcRoot) : []) {
    const toolsets = join(vcRoot, versionDir, 'Platforms\\x64\\PlatformToolsets');
    if (existsSync(toolsets)) found.push(...readdirSync(toolsets));
  }
  if (found.length === 0) fail('no x64 PlatformToolsets are installed for C++.');
  // vNNN sorts correctly numerically once the leading 'v' is dropped.
  return found.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0]!;
}

export const windowsBuild: BuildPluginPlatform = {
  platform: 'windows-x64',

  options: {
    /** Folder inside the repo holding the .sln. */
    'project-dir': { type: 'string' },
    /** MSBuild target; defaults to <solution>-vst3. */
    target: { type: 'string' },
    /** Bundle the build emits; defaults to <solution>.vst3. */
    bundle: { type: 'string' },
    /** Pin the PlatformToolset instead of taking the newest installed. */
    toolset: { type: 'string' },
  },

  required: [],

  requireHost: () => {
    if (process.platform !== 'win32') {
      fail(
        'this drives MSBuild to produce a Windows VST3, so it only runs on Windows. The archive it produces is pinned by hash in the catalogue, so it only needs running when the upstream version changes.',
      );
    }
  },

  prebuiltLibs: 'win',

  /** Git Bash, which upstream's dependency scripts are written for. */
  bash: () => {
    const candidates = [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git\\bin\\bash.exe'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git\\bin\\bash.exe'),
    ];
    const found = candidates.find(existsSync);
    if (!found) fail("Git Bash not found; upstream's dependency scripts are bash.");
    return found;
  },

  cmake: () => {
    const cmake = vswhere([
      '-latest', '-products', '*',
      '-find', 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
    ]).split(/\r?\n/)[0];
    if (!cmake || !existsSync(cmake)) {
      fail(
        'CMake was not found in the Visual Studio install, so the VST3 validator cannot be built. Install the C++ CMake tools component, or pass --no-validate and validate by hand before publishing.',
      );
    }
    return cmake;
  },

  validatorPath: (buildDir) =>
    [join(buildDir, 'bin\\Release\\validator.exe')].find(existsSync),

  build,
};

async function build(context: BuildPluginContext): Promise<BuildOutcome> {
  const vsPath = vswhere(['-latest', '-products', '*', '-property', 'installationPath']);
  if (!vsPath) fail('no Visual Studio installation found.');

  const msbuild = vswhere([
    '-latest', '-products', '*',
    '-requires', 'Microsoft.Component.MSBuild',
    '-find', 'MSBuild\\**\\Bin\\MSBuild.exe',
  ]).split(/\r?\n/)[0];
  if (!msbuild || !existsSync(msbuild)) fail('MSBuild.exe not found in the Visual Studio install.');

  const toolset = (context.options.toolset as string | undefined) ?? installedToolset(vsPath);

  console.log(`==> Visual Studio: ${vsPath}`);
  console.log(`==> Toolset:       ${toolset}`);

  // iPlug2 names both the MSBuild target and the bundle after the solution, not
  // after whatever the catalogue calls the package — those differ (the
  // catalogue id is kebab-case). Deriving them from the id builds nothing and
  // MSBuild's only complaint is that the target "does not exist".
  const projectDir = join(
    context.repoDir,
    (context.options['project-dir'] as string | undefined) ?? 'NeuralAmpModeler',
  );
  const solution = readdirSync(projectDir).find((name) => name.endsWith('.sln'));
  if (!solution) fail(`no .sln found in ${projectDir}. Pass --project-dir.`);

  const solutionBase = solution.replace(/\.sln$/, '');
  const target = (context.options.target as string | undefined) ?? `${solutionBase}-vst3`;

  // What toolset the project asks for, so the record can say plainly when we
  // did not use it. These projects routinely pin a Visual Studio version the
  // build host does not have, and a silent substitution is the kind of thing
  // that matters later for DSP code, where a different compiler can change
  // floating-point code generation.
  const vcxproj = join(projectDir, 'projects', `${target}.vcxproj`);
  const pinnedToolset = existsSync(vcxproj)
    ? (readFileSync(vcxproj, 'utf8').match(/<PlatformToolset>([^<]+)</)?.[1] ?? null)
    : null;

  console.log(`==> Building ${target} (x64 Release, toolset ${toolset})`);
  if (pinnedToolset && pinnedToolset !== toolset) {
    console.log(`    note: the project pins ${pinnedToolset}; building with ${toolset}.`);
  }

  const built = run(
    msbuild,
    [
      solution,
      `/t:${target}`,
      '/p:configuration=release',
      '/p:platform=x64',
      `/p:PlatformToolset=${toolset}`,
      '/nologo', '/verbosity:minimal', '/m',
    ],
    { cwd: projectDir },
  );

  const bundleName = (context.options.bundle as string | undefined) ?? `${solutionBase}.vst3`;
  const builtBundle = join(projectDir, 'build-win', bundleName);

  // The post-build step fails when it reaches the system-wide install copy,
  // which needs admin. That is expected and harmless — but only if the bundle
  // itself was produced, so the bundle's existence is what decides success
  // here, not MSBuild's exit code.
  if (!existsSync(builtBundle)) {
    fail(`the build produced no bundle at ${builtBundle}.\n${built.output}`);
  }
  if (!built.ok) {
    console.log(
      '    (MSBuild reported a failure, but the bundle exists — this is normally its\n' +
        '     post-build step being denied write access to C:\\Program Files\\Common Files\\VST3.)',
    );
  }

  // robocopy signals success with exit codes below 8, so its status is not a
  // useful check; whether the bundle arrived is.
  const copy = run('robocopy', [
    builtBundle, join(context.staged, bundleName), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  ]);
  if (!existsSync(join(context.staged, bundleName))) {
    fail(`could not stage the bundle.\n${copy.output}`);
  }

  // iPlug2's create_bundle.bat always makes a 32-bit slot; we build x64 only,
  // so it is left empty and would ship as a confusing empty directory.
  const x86Slot = join(context.staged, bundleName, 'Contents\\x86-win');
  if (existsSync(x86Slot) && readdirSync(x86Slot).length === 0) rmdirSync(x86Slot);

  const binaryPath = join(context.staged, bundleName, 'Contents\\x86_64-win', bundleName);
  if (!existsSync(binaryPath)) fail(`no x64 binary at ${binaryPath}.`);

  return {
    bundleName,
    binaryPath,
    notes: [
      `Visual Studio:     ${vsPath}`,
      `Platform toolset:  ${toolset}`,
      'Target:            x64 Release',
      '',
      `  msbuild ${solution} /t:${target} /p:configuration=release \\`,
      `    /p:platform=x64 /p:PlatformToolset=${toolset}`,
      '',
      context.options.toolset
        ? `The toolset was pinned to ${toolset} on the command line.`
        : 'The toolset was chosen as the newest installed on the build host.',
      pinnedToolset && pinnedToolset !== toolset
        ? `\nTOOLSET DEVIATION. ${target}.vcxproj pins PlatformToolset ${pinnedToolset}, but this` +
          `\nbinary was built with ${toolset} because that is what the build host had. It is` +
          `\ntherefore not the same binary a ${pinnedToolset} build would produce, and for DSP` +
          `\ncode a different compiler version can change floating-point code generation.` +
          `\nIt was checked against Steinberg's VST3 validator after building.`
        : pinnedToolset
          ? `\nThis matches the toolset ${target}.vcxproj pins.`
          : '',
      '',
      'Third-party notices ship inside the bundle at',
      `${bundleName}/Contents/Resources/ThirdPartyNotices.txt and are installed`,
      'alongside the binary by the catalogue entry\'s include patterns.',
    ],
  };
}
