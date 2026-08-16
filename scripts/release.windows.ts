/**
 * Build and package a local Plectrify Windows x64 release.
 *
 *   pnpm release                                step 1 — build + publish the pre-release
 *   pnpm release:promote                        step 3 — promote it to latest
 *   pnpm release:windows                        build + package only, publishing nothing
 *
 * The first two are release.ts dispatching here with --pre-release / --promote;
 * this script is what you call directly when you want neither.
 *
 * Publishing is deliberately opt-in. The normal path builds and packages
 * locally; --pre-release additionally creates an annotated tag and a GitHub
 * release that is always marked pre-release, uploading the installer, matching
 * corresponding source, and checksums using the locally authenticated gh CLI.
 * It refuses to run with --skip-tests: an untested build is never published.
 * Republishing the same version overwrites while it is still a pre-release;
 * once --promote has made a version the latest production release it is
 * immutable, and republishing it is refused — correct it with a new version.
 *
 * The macOS artifact rides the release this script creates: run `pnpm release`
 * on the Mac between steps 1 and 3 (see RELEASING.md). --promote refuses a
 * release that does not yet carry that artifact, so "latest" never means
 * Windows only. This replaced release-windows.ps1 one-for-one; PowerShell
 * survives only as a utility for Authenticode verification and elevation
 * (windows.ts).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  JUCE_PATCHED_FILES, JUCE_PATCHES, ROOT, TEST_TARGETS, bundledPluginsFor, capture, fail, pnpm,
  probe, run, sha256File,
} from './shared.ts';
import { assertWindows, findCMake, findCTest, powershell } from './windows.ts';

assertWindows('release.windows.ts');

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    'pre-release': { type: 'boolean', default: false },
    promote: { type: 'boolean', default: false },
    'skip-tests': { type: 'boolean', default: false },
    // Promotion also points plectrify.com at the new version and deploys it.
    // This opts out — for a promote run from a machine with no wrangler
    // credentials, where the site is then deployed separately.
    'no-site': { type: 'boolean', default: false },
    'webview2-installer': { type: 'string' },
    'vcredist-installer': { type: 'string' },
    'inno-compiler': { type: 'string' },
    'inno-setup-installer': { type: 'string' },
    // Download every catalogue asset and check it against its pinned SHA-256.
    // Off by default because it fetches a few hundred megabytes; run it before
    // publishing, where a rotted upstream URL or a re-cut release must fail
    // the build rather than reach users' Plugins panels.
    'verify-catalogue': { type: 'boolean', default: false },
    // Not "build\release": on a case-insensitive filesystem that is the same
    // directory as MSBuild's build\Release output inside the dev build tree,
    // and configuring CMake into it entangles the two.
    'build-directory': { type: 'string', default: 'build\\release-x64' },
  },
});

const configuration = 'Release';
const artifactRoot = join(ROOT, 'artifacts');
const stageRoot = join(artifactRoot, 'stage');
const cacheRoot = join(ROOT, '.release-cache');
const dependenciesManifest = join(ROOT, 'packaging', 'windows', 'dependencies.json');

// One source for the JUCE pin (release.macos.ts reads it the same way), so
// bumping the tag in CMakeLists.txt cannot leave a stale gate here.
const juceCommit = (() => {
  const cmake = readFileSync(join(ROOT, 'CMakeLists.txt'), 'utf8');
  const match = /GIT_TAG\s+([0-9a-f]{40})/.exec(cmake);
  if (!match) fail('could not read the pinned JUCE commit from CMakeLists.txt.');
  return match[1]!;
})();

// --- Version + flag gates (fail in a second, not after a full build) --------
const declaredVersion = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const version = values.version ?? declaredVersion;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail('version must be numeric semantic version MAJOR.MINOR.PATCH, for example 0.1.0.');
}
if (version !== declaredVersion) {
  fail(`VERSION contains '${declaredVersion}', but the command requested '${version}'.`);
}
if (values['pre-release'] && values.promote) {
  fail('--pre-release and --promote are separate steps; run them one at a time.');
}
if (values['pre-release'] && values['skip-tests']) {
  fail('--skip-tests cannot publish. It exists for iterating on packaging problems locally; run the full suite before --pre-release.');
}

// --promote only edits the published GitHub release, so it needs no clean tree.
const gitStatus = capture('git', ['-C', ROOT, 'status', '--porcelain']).trim();
if (gitStatus !== '' && !values.promote) {
  fail('the working tree is dirty. Commit the release sources before packaging.');
}
const gitCommit = capture('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/i.test(gitCommit)) fail('could not determine the release source commit.');
const gitShortCommit = gitCommit.slice(0, 12).toLowerCase();
const gitBranch =
  capture('git', ['-C', ROOT, 'symbolic-ref', '--quiet', '--short', 'HEAD']).trim() ||
  '(detached HEAD)';

/** Target the repository explicitly rather than relying on gh's inference, so
    a renamed remote fails loudly instead of publishing somewhere unexpected. */
function repoSlug(): string {
  const origin = capture('git', ['-C', ROOT, 'remote', 'get-url', 'origin']).trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(origin);
  if (!match) fail(`could not derive a GitHub owner/name from the origin remote '${origin}'.`);
  return `${match[1]}/${match[2]}`;
}

const tag = `v${version}`;

// --- --promote: flip the verified pre-release to latest, nothing else -------
if (values.promote) {
  const slug = repoSlug();
  const assets = capture('gh', ['release', 'view', tag, '--repo', slug, '--json', 'assets']);
  if (assets.trim() === '') {
    fail(`no published GitHub release ${tag} exists to promote. Run 'pnpm release' first, and check that gh is authenticated.`);
  }

  // One release, two artifacts, in order (RELEASING.md): this command is the
  // third step, and running it before the Mac has uploaded — or after it half
  // has — publishes a "latest" release with no macOS download on it. The names
  // are release.macos.ts's, so a mac artifact that was never built and one
  // whose upload was interrupted read the same way here: not promotable yet.
  const releaseAssets = (() => {
    try {
      return (JSON.parse(assets) as { assets?: { name?: string }[] }).assets ?? [];
    } catch {
      return fail(`could not read the ${tag} release assets from GitHub: ${assets.trim()}`);
    }
  })();
  const published = new Set(releaseAssets.map((asset) => asset.name));
  const macArtifacts = [
    `Plectrify-${version}-macos-arm64.dmg`,
    `Plectrify-${version}-macos-arm64.dmg.sha256`,
    'release-manifest-macos.json',
  ];
  const missing = macArtifacts.filter((name) => !published.has(name));
  if (missing.length > 0) {
    fail(`the ${tag} release is missing its macOS artifact (${missing.join(', ')}). Run 'pnpm release' on the Mac at this commit before promoting.`);
  }

  // Notes are not touched here: they were generated at publish time and may
  // have been hand-edited on GitHub since. Promotion only changes the flags.
  run(`Promoting GitHub release ${tag} to latest`, 'gh', [
    'release', 'edit', tag, '--repo', slug, '--prerelease=false', '--latest',
  ]);
  console.log(`Promoted release: https://github.com/${slug}/releases/tag/${tag}`);

  if (!values['no-site']) publishSite(version);

  process.exit(0);
}

/** Point plectrify.com's download buttons at the version just promoted, and put
    the site live.

    The site pins the version rather than asking the GitHub API at build time
    (site.ts explains why), and a pin is only as good as the thing that moves
    it. Nothing did: `VERSION` and site.ts's copy were kept in step by hand,
    which is a rule that holds right up until the release you are tired during.

    This runs *after* the release is latest, never before. The buttons deep-link
    to `releases/download/vX.Y.Z/...`, which serves a pre-release's assets
    perfectly happily — GitHub only hides those behind `/releases/latest`. So
    deploying first would put an untested build in front of strangers for as
    long as the promote took, whereas deploying second can only ever leave the
    site briefly a version behind, still pointing at downloads that work. If the
    deploy fails the promotion still stands: re-run `pnpm --dir site run deploy`
    once the cause is fixed, and nothing about the release needs redoing. */
function publishSite(releaseVersion: string): void {
  const siteDir = join(ROOT, 'site');
  const constantsPath = join(siteDir, 'src', 'lib', 'site.ts');
  const before = readFileSync(constantsPath, 'utf8');

  // The one declaration, anchored to line start so a mention in prose or a
  // comment cannot be rewritten instead.
  const declaration = /^(export const VERSION = ')([^']*)(';)$/m;
  const match = declaration.exec(before);
  if (!match) {
    fail(`could not find 'export const VERSION' in ${constantsPath}. The release is already promoted — point the site at ${releaseVersion} by hand and deploy it.`);
  }

  if (match[2] === releaseVersion) {
    console.log(`==> site.ts already points at ${releaseVersion}`);
  } else {
    writeFileSync(constantsPath, before.replace(declaration, `$1${releaseVersion}$3`));
    console.log(`==> site.ts ${match[2]} -> ${releaseVersion}`);

    // Only this file, so a promote run from a dirty tree commits what it
    // changed and nothing it happened to find lying about.
    run('Committing the site version', 'git', [
      '-C', ROOT, 'commit',
      '-m', `chore(site): point downloads at ${releaseVersion}`,
      '--only', '--', constantsPath,
    ]);
    run('Pushing the site version', 'git', ['-C', ROOT, 'push']);
  }

  if (!existsSync(join(siteDir, 'node_modules'))) {
    pnpm('Installing site tooling', ['--dir', siteDir, 'install', '--frozen-lockfile']);
  }
  // `run deploy`, not `deploy`: bare `pnpm deploy` is one of pnpm's own
  // subcommands. The script builds before publishing, so the Worker never
  // serves a stale build/.
  pnpm('Deploying plectrify.com', ['--dir', siteDir, 'run', 'deploy']);
  console.log('\nplectrify.com now offers ' + releaseVersion + '.');
}

// --- Tooling ------------------------------------------------------------------
const cmakePath = findCMake();
const ctestPath = findCTest(cmakePath);
const innoPath = ensureInnoCompiler();
const webView2Path = getDependency(values['webview2-installer'], 'webView2');
const vcRedistPath = getDependency(values['vcredist-installer'], 'visualCppRedistributable');

/** ISCC.exe: an explicit path, PATH, the conventional installs — else bootstrap
    it (winget, or the signed official installer, Authenticode-verified and
    installed elevated). */
function findInnoCompiler(): string | null {
  if (values['inno-compiler']) {
    if (!existsSync(values['inno-compiler'])) {
      fail(`Inno compiler was not found at ${values['inno-compiler']}.`);
    }
    return resolve(values['inno-compiler']);
  }
  const onPath = capture('where', ['ISCC.exe']).split(/\r?\n/)[0]?.trim();
  if (onPath && existsSync(onPath)) return onPath;

  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs\\Inno Setup 6\\ISCC.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs\\Inno Setup 7\\ISCC.exe'),
  ];
  return candidates.find(existsSync) ?? null;
}

function ensureInnoCompiler(): string {
  const existing = findInnoCompiler();
  if (existing) return existing;

  mkdirSync(cacheRoot, { recursive: true });
  let installerPath = values['inno-setup-installer'];

  if (installerPath) {
    if (!existsSync(installerPath)) fail(`Inno Setup installer was not found at ${installerPath}.`);
    installerPath = resolve(installerPath);
  } else {
    if (capture('where', ['winget']).trim() !== '') {
      const winget = spawnSync('winget', [
        'install', '--id', 'JRSoftware.InnoSetup', '--exact',
        '--source', 'winget', '--silent',
        '--accept-source-agreements', '--accept-package-agreements',
      ], { stdio: 'inherit' });
      if (winget.status === 0) {
        const found = findInnoCompiler();
        if (found) return found;
      } else {
        console.warn('warning: winget could not install Inno Setup; falling back to the official installer.');
      }
    }

    installerPath = join(cacheRoot, 'innosetup-6.7.3.exe');
    if (!existsSync(installerPath)) {
      download(
        'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe',
        installerPath,
      );
    }
  }

  // The one signature verification in this pipeline: the installer runs
  // elevated, so an unsigned or tampered download must never get that far.
  const signature = powershell(
    `(Get-AuthenticodeSignature -LiteralPath '${installerPath}').Status`,
  ).output.trim();
  if (signature !== 'Valid') {
    fail(`the Inno Setup installer signature is not valid: ${signature || 'unreadable'}.`);
  }

  const install = powershell(
    `$p = Start-Process -FilePath '${installerPath}' -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-') -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
  );
  if (!install.ok) fail(`Inno Setup installation failed.\n${install.output}`);

  const found = findInnoCompiler();
  if (!found) fail('Inno Setup was installed, but ISCC.exe was not found. Pass --inno-compiler with its path.');
  return found;
}

function download(url: string, dest: string): void {
  console.log(`==> Downloading ${basename(dest)}`);
  const result = spawnSync('curl.exe', ['-fsSL', '-o', dest, url], { stdio: 'inherit' });
  if (result.status !== 0) fail(`downloading ${url} failed.`);
}

/** A pinned dependency installer (WebView2 runtime, VC++ redistributable):
    an explicit local file, or the cached download — either way verified
    against the SHA-256 in packaging/windows/dependencies.json. */
function getDependency(overridePath: string | undefined, propertyName: string): string {
  const manifest = JSON.parse(readFileSync(dependenciesManifest, 'utf8')) as Record<
    string,
    { fileName: string; url: string; sha256?: string } | undefined
  >;
  const definition = manifest[propertyName];
  if (!definition) fail(`dependency '${propertyName}' is missing from ${dependenciesManifest}.`);

  let resolved: string;
  if (overridePath) {
    if (!existsSync(overridePath)) fail(`dependency override was not found: ${overridePath}`);
    resolved = resolve(overridePath);
  } else {
    mkdirSync(cacheRoot, { recursive: true });
    resolved = join(cacheRoot, definition.fileName);
    if (!existsSync(resolved)) download(definition.url, resolved);
  }

  const actualHash = sha256File(resolved);
  if (definition.sha256) {
    if (actualHash !== definition.sha256.toLowerCase()) {
      fail(
        `SHA-256 mismatch for ${definition.fileName}. Expected ${definition.sha256}, got ${actualHash}. ` +
          "Microsoft refreshes these 'evergreen' download URLs periodically; if the upstream installer " +
          'legitimately changed, verify it and update url/sha256 in packaging/windows/dependencies.json, ' +
          'or pass a known-good local file via --webview2-installer / --vcredist-installer.',
      );
    }
  } else {
    console.warn(`warning: no pinned SHA-256 is recorded for ${definition.fileName}; obtained ${actualHash}.`);
  }
  return resolved;
}

/** Stage the plugins Plectrify ships (packaging/bundled-plugins.json) into the
    installer's `plugins` folder, which lands beside the executable and is on
    the app's scan path.

    Downloaded rather than rebuilt, and pinned by hash: these are the very
    archives the catalogue used to hand out, produced by
    `pnpm --dir packaging build-plugin` and carrying a PROVENANCE record of the
    tag, submodules, SDK and toolchain they were built from. Re-compiling here
    would put a 20-minute build and a toolchain dependency in the release path
    for a binary that already exists and is already accounted for. The hash
    check is what makes downloading it equivalent to having built it. */
function stageBundledPlugins(destination: string): void {
  const plugins = bundledPluginsFor('windows-x64');
  if (plugins.length === 0) return;

  mkdirSync(destination, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  for (const plugin of plugins) {
    console.log(`==> Staging ${plugin.name} ${plugin.version}`);
    const archive = join(cacheRoot, `${plugin.id}-${plugin.version}-win-x64.zip`);
    if (!existsSync(archive)) download(plugin.asset.url, archive);

    const actual = sha256File(archive);
    if (actual !== plugin.asset.sha256.toLowerCase()) {
      // Never "re-download and hope": a mismatch here would put an
      // unaccounted-for binary inside the installer, which is exactly what the
      // pin exists to prevent.
      fail(
        `SHA-256 mismatch for ${plugin.name}. Expected ${plugin.asset.sha256}, got ${actual}. ` +
          'If the build legitimately changed, update packaging/bundled-plugins.json.',
      );
    }

    // tar.exe (bsdtar) reads zip, and is the same extractor the source archive
    // step uses — no PowerShell in the release path.
    run('stage plugin', 'tar.exe', ['-xf', archive, '-C', destination]);

    // The archive is a package payload, so what it contains is a claim rather
    // than a certainty. The app looks for this bundle by name.
    if (!existsSync(join(destination, plugin.bundleName)))
      fail(`${plugin.name}'s archive did not contain ${plugin.bundleName}.`);
  }
}

// --- Licence + catalogue gates --------------------------------------------------
// Byte-exact canonical AGPLv3: refuse to package a stub or accidentally
// replaced licence. Same pin as release.macos.ts.
const licenseBytes = readFileSync(join(ROOT, 'LICENSE'));
if (
  licenseBytes.length !== 34523 ||
  sha256File(join(ROOT, 'LICENSE')) !== '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0'
) {
  fail('LICENSE is not the complete canonical 34,523-byte GNU AGPLv3 document.');
}

// Delegates to packaging/scripts/validate.ts rather than re-implementing the
// rules: the catalogue decides which binaries users are offered and which hash
// authorises each to be loaded into the Plectrify process, so two copies of
// those rules drifting apart is exactly the failure worth designing out.
if (!existsSync(join(ROOT, 'packaging', 'node_modules'))) {
  pnpm('Installing packaging tooling', ['--dir', join(ROOT, 'packaging'), 'install', '--frozen-lockfile']);
}
pnpm('Validating the plugin catalogue', [
  '--dir', join(ROOT, 'packaging'), 'validate',
  ...(values['verify-catalogue'] ? ['--', '--verify-assets'] : []),
]);

// --- Paths -----------------------------------------------------------------------
let buildPath = join(ROOT, values['build-directory']!);
const existingCache = join(buildPath, 'CMakeCache.txt');
if (existsSync(existingCache)) {
  const platformLine = readFileSync(existingCache, 'utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('CMAKE_GENERATOR_PLATFORM:INTERNAL='));
  const cachedPlatform = platformLine?.split('=', 2)[1]?.trim();
  if (cachedPlatform !== 'x64') {
    buildPath = `${buildPath}-x64`;
    console.warn(
      `warning: existing build cache uses platform '${cachedPlatform ?? '(none)'}'; using fresh x64 build directory: ${buildPath}`,
    );
  }
}

const stagePath = join(stageRoot, version);
const outputPath = join(artifactRoot, `${version}-${gitShortCommit}`);
const executablePath = join(buildPath, 'Plectrify_artefacts', configuration, 'Plectrify.exe');
const installerScript = join(ROOT, 'packaging', 'windows', 'Plectrify.iss');
const juceSourcePath = join(buildPath, '_deps', 'juce-src');

rmSync(stagePath, { recursive: true, force: true });
mkdirSync(stagePath, { recursive: true });
mkdirSync(outputPath, { recursive: true });

// --- UI gate + build ----------------------------------------------------------------
const uiDir = join(ROOT, 'ui');
pnpm('Installing locked UI dependencies', ['install', '--frozen-lockfile'], { cwd: uiDir });
if (!values['skip-tests']) {
  pnpm('Checking UI formatting', ['format:check'], { cwd: uiDir });
  pnpm('Checking Svelte UI', ['check'], { cwd: uiDir });
  pnpm('Running UI tests', ['test'], { cwd: uiDir });
}
pnpm('Building Svelte UI', ['build'], { cwd: uiDir });

// --- Native build + tests --------------------------------------------------------------
// A release must never link objects compiled against two versions of a header.
// MSBuild's dependency scan can miss a header change (its .tlog record survives
// interrupted builds, and header edits are exactly what it gets wrong), and a
// stale object then links cleanly into an exe with two layouts of one class —
// this shipped once: CatalogueInstaller.obj predating CataloguePackage::tags
// walked the packages vector with the old element stride and crashed every
// installed launch. The CMake cache and the fetched JUCE tree stay; only the
// object directories go, so every translation unit recompiles against the
// headers as they are now. Costs a full compile, which a release owes anyway.
if (existsSync(buildPath)) {
  for (const entry of readdirSync(buildPath)) {
    if (entry.endsWith('.dir')) {
      rmSync(join(buildPath, entry), { recursive: true, force: true });
    }
  }
}
run('Configuring Release build', cmakePath, ['-S', ROOT, '-B', buildPath, '-A', 'x64']);
run('Building Plectrify Release', cmakePath, ['--build', buildPath, '--config', configuration, '--target', 'Plectrify']);
if (!values['skip-tests']) {
  // Every test exe, or ctest silently re-runs a stale binary — and a target
  // missing from TEST_TARGETS is worse than stale: ctest reports "Not Run" for a
  // binary that was never built, which is a failure the release must not be able
  // to skip. That list carries one entry per add_test() in CMakeLists.txt.
  for (const target of TEST_TARGETS) {
    run(`Building ${target}`, cmakePath, ['--build', buildPath, '--config', configuration, '--target', target]);
  }
  run('Running native tests', ctestPath, ['--test-dir', buildPath, '-C', configuration, '--output-on-failure']);
}

if (!existsSync(executablePath)) fail(`release executable was not produced at ${executablePath}.`);

// The PDB matching this exact binary. It never ships in the installer, but it
// is archived beside it (below): a field crash reports a raw offset in the
// Event Log or a minidump, and only the PDB from the same link can map that
// back to a function. CMakeLists.txt enables /Zi + /DEBUG for Release.
const pdbPath = join(buildPath, 'Plectrify_artefacts', configuration, 'Plectrify.pdb');
if (!existsSync(pdbPath)) fail(`release PDB was not produced at ${pdbPath}.`);

// --- JUCE provenance gate ---------------------------------------------------------------
// The published source must be the exact patched tree the binary was built
// from: every patch CMake applies is declared in JUCE_PATCHES by the file it
// touches and a marker it introduces, and the gate is identical on both
// platforms because the patched tree is (see shared.ts).
if (!existsSync(join(juceSourcePath, 'LICENSE.md'))) {
  fail(`configured JUCE source was not found at ${juceSourcePath}.`);
}
const actualJuceCommit = capture('git', ['-C', juceSourcePath, 'rev-parse', 'HEAD']).trim().toLowerCase();
if (actualJuceCommit !== juceCommit) {
  fail(`expected JUCE commit ${juceCommit}, but the release build used '${actualJuceCommit}'.`);
}
for (const { file, marker, patch } of JUCE_PATCHES) {
  if (!readFileSync(join(juceSourcePath, file), 'utf8').includes(marker)) {
    fail(`the configured JUCE tree does not contain Plectrify's ${patch}.`);
  }
}
const juceChanged = capture('git', ['-C', juceSourcePath, 'diff', '--name-only'])
  .split('\n').map((line) => line.trim()).filter(Boolean).sort();
if (juceChanged.join('\n') !== JUCE_PATCHED_FILES.join('\n')) {
  fail("the JUCE checkout contains changes other than Plectrify's declared patches.");
}
if (capture('git', ['-C', juceSourcePath, 'ls-files', '--others', '--exclude-standard']).trim() !== '') {
  fail('the JUCE checkout contains untracked files; refusing to publish ambiguous corresponding source.');
}

// --- Stage ---------------------------------------------------------------------------------
copyFileSync(executablePath, join(stagePath, 'Plectrify.exe'));
cpSync(join(ROOT, 'ui', 'dist'), join(stagePath, 'ui'), { recursive: true });
copyFileSync(join(ROOT, 'LICENSE'), join(stagePath, 'LICENSE'));
copyFileSync(join(juceSourcePath, 'LICENSE.md'), join(stagePath, 'JUCE_LICENSE.md'));
copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(stagePath, 'THIRD_PARTY_NOTICES.md'));
stageBundledPlugins(join(stagePath, 'plugins'));

// --- Corresponding source ---------------------------------------------------------------
// Built from the committed Plectrify tree and the exact, already-patched JUCE
// checkout used by CMake. No untracked SDK, build output, dependency
// installer, or user data can enter this archive. Archiving/extraction uses
// the bsdtar Windows ships (tar.exe writes zip with -a) — no PowerShell, and
// no gigabytes of JUCE tree buffered in memory.
const sourceArchiveName = `Plectrify-${version}-source.zip`;
const sourceArchivePath = join(outputPath, sourceArchiveName);
const sourceWorkPath = join(stagePath, 'source-package');
const sourceBundlePath = join(sourceWorkPath, `Plectrify-${version}-source`);
const plectrifySourcePath = join(sourceBundlePath, 'plectrify');
const juceBundlePath = join(sourceBundlePath, 'juce');
const trackedSourceZip = join(sourceWorkPath, 'plectrify-tracked.zip');
mkdirSync(plectrifySourcePath, { recursive: true });
mkdirSync(juceBundlePath, { recursive: true });

run('Archiving tracked Plectrify source', 'git', [
  '-C', ROOT, 'archive', '--format=zip', `--output=${trackedSourceZip}`, 'HEAD',
]);
run('Unpacking the tracked source', 'tar', ['-x', '-f', trackedSourceZip, '-C', plectrifySourcePath]);
cpSync(juceSourcePath, juceBundlePath, {
  recursive: true,
  filter: (src) => !/(^|[\\/])\.git([\\/]|$)/.test(relative(juceSourcePath, src)),
});
writeFileSync(
  join(sourceBundlePath, 'SOURCE_BUILD_INFO.txt'),
  `Plectrify corresponding source
Version: ${version}
Plectrify commit: ${gitCommit}
JUCE commit: ${juceCommit} (JUCE 8.0.14)
JUCE patches (already applied to juce/): ${JUCE_PATCHES.map(({ patch }) => `plectrify/${patch}`).join(', ')}
Plectrify licence: GNU AGPL version 3 only
`,
);
rmSync(sourceArchivePath, { force: true });
run('Building the corresponding-source archive', 'tar', [
  '-a', '-c', '-f', sourceArchivePath, '-C', sourceWorkPath, basename(sourceBundlePath),
]);
const sourceHash = sha256File(sourceArchivePath);
const sourceChecksumPath = join(outputPath, `${sourceArchiveName}.sha256`);
writeFileSync(sourceChecksumPath, `${sourceHash}  ${sourceArchiveName}`, 'ascii');
rmSync(sourceWorkPath, { recursive: true, force: true });

const sourceReleaseUrl = `https://github.com/patrickiel/plectrify/releases/download/${tag}/${sourceArchiveName}`;
writeFileSync(
  join(stagePath, 'SOURCE_OFFER.txt'),
  `CORRESPONDING SOURCE FOR PLECTRIFY ${version}

Plectrify is distributed under the GNU Affero General Public License, version 3
only. The complete corresponding source used to build this binary,
including the exact patched JUCE source tree, is published beside the installer:

${sourceReleaseUrl}

SHA-256: ${sourceHash}

If this is a locally built package that has not been published, run
'pnpm release:windows' from the release commit; it creates ${sourceArchiveName}
beside the installer.

THIRD-PARTY PLUGINS

This offer covers Plectrify itself. Plectrify's installer contains one VST3
plugin, Neural Amp Modeler, under the MIT licence; its source, the exact
version, and where that binary came from are recorded in
THIRD_PARTY_NOTICES.md. At your request Plectrify can also download further
open-source plugins directly from each project's own release page; those
transfers are from the project to you, so each project supplies its own
binaries and its own corresponding source, at the repository the Packages
panel links to for that plugin.

Where Plectrify does host a plugin binary -- because the project publishes
nothing that system can install directly -- it does so only where that
plugin's licence permits it, and its notice travels with it. For any such
plugin under a copyleft licence, Plectrify is the one conveying that binary to
you, and the complete corresponding source for it is published and kept
available: it is the source archive on the same release of the project that
the Plugins panel links to for that plugin, and if that ever stops being
available it will be published beside the plugin download itself.

Per-plugin licences and links are shown in the app (Plugins panel) rather than
listed here, because the set of offered plugins can change without a new
Plectrify release -- a list baked into this file would go stale against it. That
is why the paragraph above names no plugin: which ones Plectrify hosts, and
under what licence, is a property of the catalogue and not of this installer.
`,
);

const buildInfoPath = join(stagePath, 'BUILD_INFO.txt');
writeFileSync(
  buildInfoPath,
  `Plectrify release
Version: ${version}
Git commit: ${gitCommit}
Git branch: ${gitBranch}
JUCE commit: ${juceCommit} (JUCE 8.0.14)
Plectrify licence: GNU AGPL version 3 only
Corresponding source: ${sourceArchiveName}
`,
);

// --- Installer -----------------------------------------------------------------------------
run('Compiling Inno Setup installer', innoPath, [
  `/DAppVersion=${version}`,
  `/DStageDir=${stagePath}`,
  `/DOutputDir=${outputPath}`,
  `/DWebView2Installer=${webView2Path}`,
  `/DVCRedistInstaller=${vcRedistPath}`,
  installerScript,
]);

const installerPath = join(outputPath, `Plectrify-${version}-win-x64-setup.exe`);
if (!existsSync(installerPath)) fail(`Inno Setup did not produce ${installerPath}.`);
const installerHash = sha256File(installerPath);
const checksumPath = join(outputPath, `Plectrify-${version}-win-x64-setup.exe.sha256`);
writeFileSync(checksumPath, `${installerHash}  ${basename(installerPath)}`, 'ascii');
copyFileSync(pdbPath, join(outputPath, `Plectrify-${version}-win-x64.pdb`));
copyFileSync(buildInfoPath, join(outputPath, 'BUILD_INFO.txt'));
writeFileSync(
  join(outputPath, 'release-manifest.json'),
  `${JSON.stringify(
    {
      product: 'Plectrify',
      version,
      sourceCommit: gitCommit,
      sourceBranch: gitBranch,
      juceCommit,
      jucePatches: JUCE_PATCHES.map(({ patch }) => patch),
      binaryLicense: 'AGPL-3.0-only',
      platform: 'windows-x64',
      installer: basename(installerPath),
      sha256: installerHash,
      sourceArchive: sourceArchiveName,
      sourceSha256: sourceHash,
      signed: false,
    },
    null,
    2,
  )}\n`,
);

// --- --pre-release: tag + publish -------------------------------------------------------
if (values['pre-release']) {
  const slug = repoSlug();
  if (capture('where', ['gh']).trim() === '') {
    fail('gh was not found; install/authenticate GitHub CLI or omit --pre-release.');
  }

  // Release notes are written by Claude from the commit subjects since the
  // previous release tag, to the fixed structure defined in
  // packaging/release-notes-prompt.md; the GitHub release is the only
  // changelog. Without the claude CLI (or if it fails) the raw commit bullets
  // are used instead — the release still ships; polish the notes on GitHub.
  const lastTag = capture('git', ['-C', ROOT, 'describe', '--tags', '--abbrev=0', '--exclude', tag]).trim();
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const subjects = capture('git', ['-C', ROOT, 'log', '--no-merges', '--pretty=format:%s', range])
    .split(/\r?\n/).filter(Boolean);
  const bullets = subjects.length ? subjects.map((s) => `- ${s}`).join('\n') : '- (describe this release)';

  let notes = bullets;
  if (capture('where', ['claude']).trim() !== '') {
    console.log('==> Writing release notes with Claude');
    const prompt = readFileSync(join(ROOT, 'packaging', 'release-notes-prompt.md'), 'utf8')
      .replaceAll('{{VERSION}}', version)
      .replaceAll('{{COMMITS}}', bullets);
    const generated = spawnSync('claude', ['-p'], {
      input: prompt, encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024,
    });
    if (generated.status === 0 && generated.stdout?.trim()) {
      notes = generated.stdout.trim();
    } else {
      console.warn(`warning: Claude did not produce release notes (exit ${generated.status}); using raw commit bullets.`);
    }
  } else {
    console.warn('warning: claude CLI not found; release notes are the raw commit bullets.');
  }
  const notesPath = join(tmpdir(), `Plectrify-${version}-release-notes.md`);
  writeFileSync(notesPath, notes, 'utf8');

  // Republishing a pre-release is the normal iterate-and-verify loop, and
  // overwrites it. A release that has been promoted to latest is published for
  // real: people may already hold the installer and its checksum, so that
  // version is immutable. Delete the release before its tag: a release whose
  // tag has vanished is left dangling as a draft.
  if (probe('gh', ['release', 'view', tag, '--repo', slug]) === 0) {
    const isPrerelease = capture('gh', [
      'release', 'view', tag, '--repo', slug, '--json', 'isPrerelease', '-q', '.isPrerelease',
    ]).trim();
    if (isPrerelease !== 'true') {
      fail(`${tag} is already promoted to a production release and cannot be replaced. Bump VERSION and release a new version instead.`);
    }
    console.warn(`warning: replacing pre-release ${tag}; any hand-edited release notes on GitHub will be lost.`);
    run(`Deleting existing GitHub release ${tag}`, 'gh', ['release', 'delete', tag, '--repo', slug, '--yes']);
  }
  if (probe('git', ['-C', ROOT, 'ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]) === 0) {
    run(`Deleting remote Git tag ${tag}`, 'git', ['-C', ROOT, 'push', 'origin', '--delete', tag]);
  }
  if (capture('git', ['-C', ROOT, 'tag', '--list', tag]).trim() !== '') {
    run(`Deleting local Git tag ${tag}`, 'git', ['-C', ROOT, 'tag', '-d', tag]);
  }

  run(`Creating Git tag ${tag}`, 'git', ['-C', ROOT, 'tag', '-a', tag, '-m', `Plectrify ${version}`]);
  // Push the tag before creating the release: otherwise gh mints a remote tag
  // of the same name at whatever commit the remote's default branch is on,
  // which need not be the audited release commit.
  run(`Pushing Git tag ${tag}`, 'git', ['-C', ROOT, 'push', 'origin', tag]);

  // Confirm the push landed, rather than inferring it from an exit code. A
  // tag that exists only locally is the one release failure with no local
  // symptom at all: this box builds, installs and plays fine, while the Mac
  // half refuses to start (release.macos.ts gates on this same ref) and
  // `git checkout vX.Y.Z` finds nothing on any other machine. Peel the ref —
  // an annotated tag advertises the tag object first and the commit under
  // `^{}`, so reading the unpeeled line would compare a tag object's SHA
  // against HEAD and reject every ordinary release.
  const refs = capture('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && /^[0-9a-f]{40}$/i.test(parts[0]!));
  const refCommit = (name: string) => refs.find((parts) => parts[1] === name)?.[0] ?? '';
  const pushedCommit = (refCommit(`refs/tags/${tag}^{}`) || refCommit(`refs/tags/${tag}`)).toLowerCase();

  if (pushedCommit === '') {
    fail(`pushed ${tag}, but origin does not carry it. Push it by hand ('git push origin ${tag}') and re-run.`);
  }
  if (pushedCommit !== gitCommit.toLowerCase()) {
    fail(`origin's ${tag} names ${pushedCommit}, but this release was built from ${gitCommit}.`);
  }

  run(`Publishing GitHub pre-release ${tag}`, 'gh', [
    'release', 'create', tag,
    installerPath,
    checksumPath,
    sourceArchivePath,
    sourceChecksumPath,
    join(outputPath, 'BUILD_INFO.txt'),
    join(outputPath, 'release-manifest.json'),
    '--repo', slug,
    '--verify-tag',
    // This script only ever publishes pre-releases; promoting one to the
    // latest production release stays a manual, deliberate step.
    '--prerelease',
    '--title', `Plectrify ${version}`,
    '--notes-file', notesPath,
  ]);
  console.log(`Published pre-release: https://github.com/${slug}/releases/tag/${tag}`);
  console.log(`Add the mac artifact next (pnpm release, on the Mac), then promote with: pnpm release:promote`);
}

console.log(`Release ready: ${installerPath}`);
console.log(`Corresponding source ready: ${sourceArchivePath}`);
