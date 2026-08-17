/**
 * Build, sign, notarize and publish the macOS release artifact — the mac
 * counterpart of release.windows.ts, which stays the Windows pipeline untouched.
 *
 *   pnpm release                              build + sign + notarize + upload
 *   pnpm release --ad-hoc                     build + ad-hoc sign + upload (no Apple account)
 *   pnpm release --no-upload                  rehearse locally (still signs/notarizes)
 *   pnpm release --no-notarize --no-upload    fast local packaging check
 *   pnpm release --skip-tests --no-upload     iterate on packaging problems only
 *
 * `pnpm release` is release.ts, which dispatches here on macOS and to
 * release.windows.ts on Windows; this file is the mac half of that one command.
 *
 * THE MAC ARTIFACT RIDES THE WINDOWS RELEASE. Step 1 on the Windows box creates
 * the tag, the GitHub pre-release, and the AGPL corresponding-source archive;
 * this script verifies it is building the very same commit, then uploads
 * Plectrify-<version>-macos-arm64.pkg beside the Windows installer. Update
 * discovery reads only the release tag, so a second asset needs no app change.
 * Run order per release: pnpm release (Windows box) → pnpm release (Mac) →
 * pnpm release:promote (Windows box).
 *
 * THE ARTIFACT IS AN INSTALLER PACKAGE, NOT A DISK IMAGE. A DMG can only offer
 * drag targets, and the plugin's — /Library/Audio/Plug-Ins/VST3 — does not
 * exist on a Mac that has never had a VST3 installed (stock macOS creates
 * Components and HAL under /Library/Audio/Plug-Ins, never VST3), so the drag
 * fails with "the original item can't be found" on exactly the machines a
 * first install meets. An installer package creates its destinations itself,
 * which is why a .pkg is what audio software actually ships as. One product
 * installs every build, always: no component choice, so an app/plugin version
 * skew is unrepresentable — the same promise the Windows installer makes with
 * [InstallDelete], made here by never installing half.
 *
 * One-time Mac setup (see RELEASING.md): an Apple Developer ID Application
 * certificate (seals the bundles) and a Developer ID Installer certificate
 * (seals the pkg) in the keychain, and a notarytool keychain profile:
 *   xcrun notarytool store-credentials plectrify --apple-id ... --team-id ...
 *
 * Signing gates that differ from Windows (which ships unsigned for now):
 * hardened runtime + notarization are the default here — Gatekeeper blocks an
 * unsigned download outright — and the entitlements in
 * cmake/Plectrify.entitlements (audio input, library validation off for
 * third-party VST3s) must ride the bundle signatures or the app is silent and
 * pluginless.
 *
 * --ad-hoc IS THE ONE PUBLISHABLE MODE THAT NEEDS NO APPLE ACCOUNT. Developer ID
 * signing and notarization both require a paid Apple Developer Program
 * membership; there is no free tier and no open-source exemption. Rather than
 * leave the Mac unreleasable until that is bought, --ad-hoc signs the bundles
 * with the ad-hoc identity (`-`), leaves the pkg unsigned (there is no ad-hoc
 * for installer products), skips notarization, and is still allowed to upload.
 * What that costs is real and falls on the user, not on this script: the pkg
 * carries a quarantine flag when downloaded through a browser, and macOS
 * refuses to open a quarantined unsigned installer. Recovering from it is
 * System Settings -> Privacy & Security -> Open Anyway, or
 * `xattr -d com.apple.quarantine`; distribution channels that do not set
 * quarantine at all (a Homebrew tap, curl, git) are unaffected.
 *
 * Ad-hoc deliberately drops the hardened runtime along with the certificate.
 * The runtime is a *requirement of* notarization, not a benefit on its own, and
 * keeping it here would enforce library validation against third-party VST3s
 * signed by other people — the exact thing disable-library-validation exists to
 * undo. Dropping it makes plugin hosting unconditional instead of dependent on
 * whether that entitlement is honoured under a certificate-less seal.
 *
 * One consequence worth knowing: TCC identifies an ad-hoc app by its cdhash, so
 * every version asks for microphone permission again. A Developer ID app keeps
 * it across updates. That alone is a decent reason to buy the membership once
 * there is a user base to annoy.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  JUCE_PATCHED_FILES, JUCE_PATCHES, ROOT, TEST_TARGETS, bundledPluginsFor, capture, fail, pnpm,
  run, sha256File,
} from './shared.ts';
import {
  appPath,
  assertMacos,
  buildDir,
  buildTarget,
  configure,
  stageUiIntoBundle,
} from './macos.ts';

assertMacos('release.macos.ts');

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    identity: { type: 'string', default: 'Developer ID Application' },
    'installer-identity': { type: 'string', default: 'Developer ID Installer' },
    'keychain-profile': { type: 'string', default: 'plectrify' },
    'skip-tests': { type: 'boolean', default: false },
    'ad-hoc': { type: 'boolean', default: false },
    'no-notarize': { type: 'boolean', default: false },
    'no-upload': { type: 'boolean', default: false },
  },
});

const CONFIG = 'Release';

const adHoc = values['ad-hoc']!;
const identity = adHoc ? '-' : values.identity!;
const installerIdentity = values['installer-identity']!;
const notarize = !adHoc && !values['no-notarize'];

// --identity names a certificate; ad-hoc is the absence of one. Taking both
// would mean silently ignoring the one the command asked for by name.
if (adHoc && values.identity !== 'Developer ID Application') {
  fail(`--ad-hoc signs with no certificate, so it cannot also use --identity '${values.identity}'. Drop one.`);
}
if (adHoc && values['installer-identity'] !== 'Developer ID Installer') {
  fail(`--ad-hoc leaves the pkg unsigned, so it cannot also use --installer-identity '${values['installer-identity']}'. Drop one.`);
}

// A rehearsal cannot be promoted by hand: notarization staples a ticket into
// the pkg, so an un-notarized rehearsal artifact differs from the real one.
// --ad-hoc is exempt because there the un-notarized pkg *is* the artifact —
// nothing better exists to compare it against, and the whole point is to
// publish it.
if (!adHoc && values['no-notarize'] && !values['no-upload']) {
  fail('--no-notarize is a local rehearsal switch; pair it with --no-upload. To publish without notarizing at all, use --ad-hoc.');
}

// The same rule release.windows.ts states as "--skip-tests cannot publish",
// which it enforces by refusing --pre-release. Publishing here is the default
// rather than a flag, so the pairing is the other way round — but an untested
// build must not reach a release either way, and signing and notarizing one
// makes it no more tested.
if (values['skip-tests'] && !values['no-upload']) {
  fail('--skip-tests cannot publish; pair it with --no-upload. It exists for iterating on packaging problems locally — run the full suite before uploading.');
}

// Ask the keychain now rather than discovering it at the first codesign call,
// twenty minutes of build and test later. codesign's own answer to a missing
// certificate is "Developer ID Application: no identity found", which says
// neither where the certificate comes from nor that --ad-hoc exists.
if (!adHoc) {
  const identities = capture('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.includes(identity)) {
    fail(
      `no '${identity}' certificate in the login keychain (security find-identity found none).\n` +
        '  Developer ID signing and notarization need a paid Apple Developer Program membership.\n' +
        '  To publish without one, re-run with --ad-hoc — the pkg is then unsigned and unnotarized,\n' +
        '  and macOS refuses to open it until whoever downloads it clears the quarantine flag.',
    );
  }
  // The pkg's certificate is a different type from the bundles' — an Installer
  // identity is not a codesigning identity, so it is asked for without that
  // policy filter, and its absence has to be its own message or the first
  // productbuild failure names neither certificate nor fix.
  const installerIdentities = capture('security', ['find-identity', '-v']);
  if (!installerIdentities.includes(installerIdentity)) {
    fail(
      `no '${installerIdentity}' certificate in the login keychain (security find-identity found none).\n` +
        '  The installer pkg is signed with a Developer ID *Installer* certificate — a separate\n' +
        '  certificate type from Developer ID Application, issued from the same paid membership.\n' +
        '  To publish without one, re-run with --ad-hoc.',
    );
  }
}

// --- Version + clean-tree gates (same rules as release.windows.ts) ----------------
const declaredVersion = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const version = values.version ?? declaredVersion;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail('version must be numeric semantic version MAJOR.MINOR.PATCH, for example 0.1.0.');
}
if (version !== declaredVersion) {
  fail(`VERSION contains '${declaredVersion}', but the command requested '${version}'.`);
}

if (capture('git', ['-C', ROOT, 'status', '--porcelain']).trim() !== '') {
  fail('the working tree is dirty. Commit the release sources before packaging.');
}
const commit = capture('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) fail('could not determine the release source commit.');
const branch = capture('git', ['-C', ROOT, 'symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
  || '(detached HEAD)';

// --- Licence + catalogue gates ----------------------------------------------
// Byte-exact canonical AGPLv3, same pin as release.windows.ts: refuse to package a
// stub or accidentally replaced licence.
const licenseBytes = readFileSync(join(ROOT, 'LICENSE'));
const licenseHash = createHash('sha256').update(licenseBytes).digest('hex');
if (
  licenseBytes.length !== 34523 ||
  licenseHash !== '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0'
) {
  fail('LICENSE is not the complete canonical 34,523-byte GNU AGPLv3 document.');
}

// Delegate catalogue validation to the one implementation of the rules.
if (!existsSync(join(ROOT, 'packaging/node_modules'))) {
  pnpm('Installing packaging tooling', ['--dir', join(ROOT, 'packaging'), 'install', '--frozen-lockfile']);
}
pnpm('Validating the plugin catalogue', ['--dir', join(ROOT, 'packaging'), 'validate']);

// --- The tag must exist and name this commit --------------------------------
// The Windows pipeline creates the tag, the release, and the corresponding-
// source archive. Building anything else here would publish a mac binary whose
// published source is not its source.
const tag = `v${version}`;
const repoSlug = (() => {
  const origin = capture('git', ['-C', ROOT, 'remote', 'get-url', 'origin']).trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(origin);
  if (!match) fail(`could not derive a GitHub owner/name from the origin remote '${origin}'.`);
  return `${match[1]}/${match[2]}`;
})();

let sourceArchiveHash = '';
if (!values['no-upload']) {
  // ls-remote answers in refname order rather than the order it was asked, and
  // an annotated tag — which is what --pre-release creates — advertises two
  // refs: the tag object, then the commit it peels to under `^{}`. Reading the
  // first line therefore compares a tag object's SHA against HEAD and rejects
  // every ordinary release. Peel it; a lightweight tag has only the one ref and
  // falls back to it.
  const refs = capture('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && /^[0-9a-f]{40}$/i.test(parts[0]!));
  const refCommit = (name: string) => refs.find((parts) => parts[1] === name)?.[0] ?? '';
  const taggedCommit = refCommit(`refs/tags/${tag}^{}`) || refCommit(`refs/tags/${tag}`);

  if (taggedCommit === '') {
    fail(`no remote tag ${tag}. Publish the Windows pre-release first ('pnpm release' on the Windows box) — it creates the tag, the GitHub release and the corresponding-source archive this artifact rides with.`);
  }
  if (taggedCommit.toLowerCase() !== commit.toLowerCase()) {
    fail(`remote tag ${tag} names ${taggedCommit}, but this checkout is at ${commit}. Check out the release commit.`);
  }

  // Once --promote has made a version the latest production release it is
  // immutable: people may already hold that pkg and the checksum published
  // beside it. The upload below passes --clobber, which would replace both in
  // place, so the answer has to be no here rather than after a full build and a
  // notarization round-trip.
  const release = (() => {
    const json = capture('gh', ['release', 'view', tag, '--repo', repoSlug, '--json', 'isPrerelease']);
    if (json.trim() === '') {
      fail(`could not read a GitHub release for ${tag} — publish the Windows pre-release first ('pnpm release' on the Windows box), and check that gh is authenticated.`);
    }
    try {
      return JSON.parse(json) as { isPrerelease?: boolean };
    } catch {
      return fail(`could not read the ${tag} release from GitHub: ${json.trim()}`);
    }
  })();
  if (release.isPrerelease !== true) {
    fail(`release ${tag} has already been promoted to latest, and a promoted version is immutable — people may already hold its published checksums. Correct it by bumping VERSION and releasing again.`);
  }

  // The published source-archive hash, for SOURCE_OFFER.txt inside the bundle.
  const sidecar = capture('gh', [
    'release', 'download', tag, '--repo', repoSlug,
    '--pattern', `Plectrify-${version}-source.zip.sha256`, '--output', '-',
  ]).trim();
  sourceArchiveHash = sidecar.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(sourceArchiveHash)) {
    fail(`the ${tag} release carries no Plectrify-${version}-source.zip.sha256 — publish it from release.windows.ts first.`);
  }
}

// --- UI gate + build ---------------------------------------------------------
const uiDir = join(ROOT, 'ui');
pnpm('Installing UI dependencies', ['install', '--frozen-lockfile'], { cwd: uiDir });
pnpm('UI formatting check', ['format:check'], { cwd: uiDir });
pnpm('svelte-check', ['check'], { cwd: uiDir });
pnpm('UI tests', ['test'], { cwd: uiDir });
pnpm('Building UI', ['build'], { cwd: uiDir });

// --- Native build + tests ----------------------------------------------------
configure(CONFIG);
buildTarget(CONFIG, 'Plectrify');
buildTarget(CONFIG, 'PlectrifyPlugin_VST3');
buildTarget(CONFIG, 'PlectrifyPlugin_AU');
if (!values['skip-tests']) {
  // A target missing from TEST_TARGETS is reported by ctest as "Not Run" rather
  // than as a pass, so that list carries one entry per add_test() in
  // CMakeLists.txt and every script builds all of it.
  for (const target of TEST_TARGETS) {
    buildTarget(CONFIG, target);
  }
  run('Running native tests', 'ctest', ['--test-dir', buildDir(CONFIG), '--output-on-failure']);
}

const app = appPath(CONFIG);
if (!existsSync(join(app, 'Contents/MacOS/Plectrify'))) {
  fail(`release app was not produced at ${app}.`);
}

// The plugin bundles, gated the same way as the app: on their Mach-Os. (No
// dSYM gate on any — the mac build produces no separate debug symbols yet;
// Windows gates on PDBs because MSVC already emits them.)
const pluginArtefacts = join(buildDir(CONFIG), 'PlectrifyPlugin_artefacts', CONFIG);
const vst3Built = join(pluginArtefacts, 'VST3', 'Plectrify.vst3');
if (!existsSync(join(vst3Built, 'Contents/MacOS/Plectrify'))) {
  fail(`release VST3 was not produced at ${vst3Built}.`);
}
const auBuilt = join(pluginArtefacts, 'AU', 'Plectrify.component');
if (!existsSync(join(auBuilt, 'Contents/MacOS/Plectrify'))) {
  fail(`release AU was not produced at ${auBuilt}.`);
}

// --- JUCE provenance gate ----------------------------------------------------
// The published source must be the exact patched tree the binary was built
// from, so every patch CMake applies is declared here by the file it touches
// and a marker string it introduces: the marker proves the patch is present,
// and the file list proves nothing else was changed. Both patches are declared
// on both platforms because CMake applies both everywhere — each is guarded
// internally, so the tree, and this gate, are the same on either OS.
const juceCommitPin = (() => {
  const cmake = readFileSync(join(ROOT, 'CMakeLists.txt'), 'utf8');
  const match = /GIT_TAG\s+([0-9a-f]{40})/.exec(cmake);
  if (!match) fail('could not read the pinned JUCE commit from CMakeLists.txt.');
  return match[1]!;
})();
const juceSource = join(buildDir(CONFIG), '_deps/juce-src');
const juceCommit = capture('git', ['-C', juceSource, 'rev-parse', 'HEAD']).trim().toLowerCase();
if (juceCommit !== juceCommitPin) {
  fail(`expected JUCE commit ${juceCommitPin}, but the release build used '${juceCommit}'.`);
}
for (const { file, marker, patch } of JUCE_PATCHES) {
  if (!readFileSync(join(juceSource, file), 'utf8').includes(marker)) {
    fail(`the configured JUCE tree does not contain Plectrify's ${patch}.`);
  }
}
const juceChanged = capture('git', ['-C', juceSource, 'diff', '--name-only'])
  .split('\n').map((line) => line.trim()).filter(Boolean).sort();
if (juceChanged.join('\n') !== JUCE_PATCHED_FILES.join('\n')) {
  fail('the JUCE checkout contains changes other than Plectrify\'s declared patches.');
}
if (capture('git', ['-C', juceSource, 'ls-files', '--others', '--exclude-standard']).trim() !== '') {
  fail('the JUCE checkout contains untracked files; refusing to publish ambiguous corresponding source.');
}

/** The codesign flags every seal in this script shares.

    Developer ID carries the hardened runtime and a trusted timestamp because
    notarization refuses a submission without both. Ad-hoc carries neither: a
    signature with no certificate behind it has nothing for a timestamp
    authority to countersign, and the hardened runtime would switch on library
    validation — which is what stops a bundle signed by somebody else loading
    into this process, i.e. every third-party VST3 the app exists to host.
    Entitlements ride both, inert under ad-hoc but keeping one bundle shape. */
function signArgs(): string[] {
  return adHoc
    ? ['--force', '--timestamp=none', '--sign', identity]
    : ['--force', '--options', 'runtime', '--timestamp', '--sign', identity];
}

/** Stage the plugins Plectrify ships (packaging/bundled-plugins.json) into
    Contents/Resources/plugins — inside the bundle, and therefore inside the
    signature seal, which is why it happens before codesign like everything else
    staged here.

    Downloaded and hash-checked rather than rebuilt: these are the archives
    `pnpm --dir packaging build-plugin` produced, with a PROVENANCE record
    beside each. Extraction keeps the bundle's permission bits and symlinks —
    ditto rather than `unzip`, since a mac VST3's Mach-O has to stay executable
    and a framework's Versions/Current has to stay a link, or the plugin hashes
    fine and refuses to load. */
function stageBundledPlugins(destination: string): void {
  const plugins = bundledPluginsFor('macos-arm64');
  if (plugins.length === 0) return;

  // Same cache the Windows release uses, and gitignored for the same reason:
  // a pinned download is worth keeping between runs and worth nobody's commit.
  const cacheRoot = join(ROOT, '.release-cache');
  mkdirSync(destination, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  for (const plugin of plugins) {
    console.log(`==> Staging ${plugin.name} ${plugin.version}`);
    const archive = join(cacheRoot, `${plugin.id}-${plugin.version}-macos-arm64.zip`);
    if (!existsSync(archive)) run('download plugin', 'curl', ['-fsSL', '-o', archive, plugin.asset.url]);

    const actual = sha256File(archive);
    if (actual !== plugin.asset.sha256.toLowerCase()) {
      fail(
        `SHA-256 mismatch for ${plugin.name}. Expected ${plugin.asset.sha256}, got ${actual}. ` +
          'If the build legitimately changed, update packaging/bundled-plugins.json.',
      );
    }

    run('extract plugin', 'ditto', ['-x', '-k', archive, destination]);

    const bundle = join(destination, plugin.bundleName);
    if (!existsSync(bundle))
      fail(`${plugin.name}'s archive did not contain ${plugin.bundleName}.`);

    // The pinned archive records no Unix modes at all, so ditto extracts the
    // Mach-O 0644. dyld will dlopen a bundle without +x today, but nothing
    // shipped should lean on that leniency — and whatever sits under
    // Contents/MacOS is executable by definition, so the bit is restored from
    // that knowledge rather than from metadata the archive failed to carry.
    const machODir = join(bundle, 'Contents/MacOS');
    if (existsSync(machODir))
      for (const binary of readdirSync(machODir)) chmodSync(join(machODir, binary), 0o755);

    // Signed as part of the app: a nested bundle has to be sealed before its
    // container, and the deep sign the app gets below does not reach an
    // unsigned one that arrived after it. Ad-hoc is enough for loading, so in
    // --ad-hoc mode that is exactly what it gets; a notarized build carries the
    // same identity as its container.
    run('Codesigning ' + plugin.name, 'codesign', [...signArgs(), bundle]);
  }
}

// --- Stage the bundle's documents, then the UI (all before signing) ----------
const resources = join(app, 'Contents/Resources');
const sourceArchiveName = `Plectrify-${version}-source.zip`;
const sourceUrl = `https://github.com/${repoSlug}/releases/download/${tag}/${sourceArchiveName}`;

copyFileSync(join(ROOT, 'LICENSE'), join(resources, 'LICENSE'));
copyFileSync(join(juceSource, 'LICENSE.md'), join(resources, 'JUCE_LICENSE.md'));
copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'));
writeFileSync(
  join(resources, 'SOURCE_OFFER.txt'),
  `CORRESPONDING SOURCE FOR PLECTRIFY ${version}

Plectrify is distributed under the GNU Affero General Public License, version 3
only. The complete corresponding source used to build this binary,
including the exact patched JUCE source tree, is published beside the
installers:

${sourceUrl}
${sourceArchiveHash ? `\nSHA-256: ${sourceArchiveHash}\n` : ''}
THIRD-PARTY PLUGINS

This offer covers Plectrify itself — the standalone application and the
Plectrify VST3 and Audio Unit plug-ins this installer installs, which are
builds of the same AGPLv3 source in the archive above. (All of them host VST3
plug-ins and are built against Steinberg's VST3 SDK as bundled with JUCE,
which Plectrify uses under the SDK's GPLv3 option; see
THIRD_PARTY_NOTICES.md.) Plectrify ships one third-party VST3
plugin, Neural Amp Modeler, under the MIT licence; its source, the exact
version, and where that binary came from are recorded in
THIRD_PARTY_NOTICES.md. At your request
Plectrify can also download further open-source plugins directly from each
project's own release page; those transfers are from the project to you, so each
project supplies its own binaries and its own corresponding source, at the
repository the Packages panel links to for that plugin.

Where Plectrify does host a plugin binary -- because the project publishes
nothing that system can install directly -- it does so only where that
plugin's licence permits it, and its notice travels with it. For any such
plugin under a copyleft licence, Plectrify is the one conveying that binary to
you, and the complete corresponding source for it is published and kept
available: it is the source archive on the same release of the project that
the Plugins panel links to for that plugin, and if that ever stops being
available it will be published beside the plugin download itself.
`,
);
writeFileSync(
  join(resources, 'BUILD_INFO.txt'),
  `Plectrify release
Version: ${version}
Git commit: ${commit}
Git branch: ${branch}
JUCE commit: ${juceCommit} (JUCE 8.0.14)
Plectrify licence: GNU AGPL version 3 only
Corresponding source: ${sourceArchiveName}
`,
);
stageUiIntoBundle(CONFIG);
stageBundledPlugins(join(resources, 'plugins'));

// --- Sign, package, notarize, staple ----------------------------------------
// Everything staged above sits inside the seal; nothing may touch the bundle
// after this point.
run('Codesigning Plectrify.app', 'codesign', [
  '--entitlements', join(ROOT, 'cmake/Plectrify.entitlements'),
  ...signArgs(),
  app,
]);
run('Verifying the signature', 'codesign', ['--verify', '--strict', '--verbose=2', app]);

const outputDir = join(ROOT, 'artifacts');
mkdirSync(outputDir, { recursive: true });

// --- The plugins, made self-contained and sealed on their own ----------------
// A Release binary has no source-tree fallback (the PLECTRIFY_UI_DIST_DIR /
// PLECTRIFY_BUNDLED_PLUGIN_DIR compile symbols are Debug-only), so each
// bundle carries its own copy of the UI and the shipped plugins under
// Contents/Resources — the layout moduleResourceDir() resolves. Same rule as
// the Windows installer's vst3 staging: a plugin loaded by a DAW must not
// depend on where, or whether, the standalone is installed.
//
// Each gets a seal of its own, independent of the app's: the bundles are
// installed to different places and any can outlive the others. Explicit
// entitlements because this is a Ninja build — the plugin target's
// HARDENED_RUNTIME_OPTIONS in CMakeLists.txt only take effect under the Xcode
// generator — and the file's two entitlements are exactly that list.
const pkgStage = join(outputDir, 'pkg-stage');
rmSync(pkgStage, { recursive: true, force: true });
mkdirSync(join(pkgStage, 'app'), { recursive: true });

for (const plugin of [
  { built: vst3Built, root: 'vst3', bundle: 'Plectrify.vst3' },
  { built: auBuilt, root: 'au', bundle: 'Plectrify.component' },
]) {
  const staged = join(pkgStage, plugin.root, plugin.bundle);
  mkdirSync(join(pkgStage, plugin.root), { recursive: true });
  run(`Staging ${plugin.bundle}`, 'ditto', [plugin.built, staged]);
  cpSync(join(uiDir, 'dist'), join(staged, 'Contents/Resources/ui'), { recursive: true });
  stageBundledPlugins(join(staged, 'Contents/Resources/plugins'));
  run(`Codesigning ${plugin.bundle}`, 'codesign', [
    '--entitlements', join(ROOT, 'cmake/Plectrify.entitlements'),
    ...signArgs(),
    staged,
  ]);
  run('Verifying the plugin signature', 'codesign', ['--verify', '--strict', '--verbose=2', staged]);
}

// --- The installer: one pkg, both builds, no choices -------------------------
// A component plist per bundle, because pkgbuild's defaults are wrong for
// this: without one every bundle is marked relocatable, and Installer will
// happily "upgrade" a stray copy it finds elsewhere — on a dev machine, the
// one inside build-macos-release — instead of the install location. Not
// relocatable, not version-checked: an install always lands whole at its
// destination, replacing whatever version sits there, so rerunning the
// installer is a repair.
run('Staging Plectrify.app', 'ditto', [app, join(pkgStage, 'app', 'Plectrify.app')]);

function componentPlist(bundleName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>RootRelativeBundlePath</key><string>${bundleName}</string>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
    <key>BundleHasStrictIdentifier</key><true/>
  </dict>
</array>
</plist>
`;
}
writeFileSync(join(pkgStage, 'app.plist'), componentPlist('Plectrify.app'));
writeFileSync(join(pkgStage, 'vst3.plist'), componentPlist('Plectrify.vst3'));
writeFileSync(join(pkgStage, 'au.plist'), componentPlist('Plectrify.component'));

// The components are left unsigned — the signature that counts is the
// product's, below — and carry no scripts, so notarization has nothing to
// object to and the payload is pure bundle copy.
run('Packaging the app component', 'pkgbuild', [
  '--root', join(pkgStage, 'app'),
  '--component-plist', join(pkgStage, 'app.plist'),
  '--identifier', 'io.github.patrickiel.plectrify.pkg.app',
  '--version', version,
  '--install-location', '/Applications',
  join(pkgStage, 'PlectrifyApp.pkg'),
]);
run('Packaging the VST3 component', 'pkgbuild', [
  '--root', join(pkgStage, 'vst3'),
  '--component-plist', join(pkgStage, 'vst3.plist'),
  '--identifier', 'io.github.patrickiel.plectrify.pkg.vst3',
  '--version', version,
  '--install-location', '/Library/Audio/Plug-Ins/VST3',
  join(pkgStage, 'PlectrifyVst3.pkg'),
]);
run('Packaging the AU component', 'pkgbuild', [
  '--root', join(pkgStage, 'au'),
  '--component-plist', join(pkgStage, 'au.plist'),
  '--identifier', 'io.github.patrickiel.plectrify.pkg.au',
  '--version', version,
  '--install-location', '/Library/Audio/Plug-Ins/Components',
  join(pkgStage, 'PlectrifyAu.pkg'),
]);

// customize="never": both components install, always — an app/plugin version
// skew is unrepresentable, the promise the Windows installer makes with
// [InstallDelete]. It also means Installer creates
// /Library/Audio/Plug-Ins/VST3 itself, which is the reason this is a pkg and
// not a DMG: that folder does not exist on a Mac that never had a VST3
// installed, so a disk image's drag target dangles on exactly the machines a
// first install meets.
writeFileSync(
  join(pkgStage, 'distribution.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Plectrify ${version}</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
    <domains enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions><os-version min="13.3"/></allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default">
            <line choice="app"/>
            <line choice="vst3"/>
            <line choice="au"/>
        </line>
    </choices-outline>
    <choice id="default" title="Plectrify"/>
    <choice id="app" visible="false">
        <pkg-ref id="io.github.patrickiel.plectrify.pkg.app"/>
    </choice>
    <choice id="vst3" visible="false">
        <pkg-ref id="io.github.patrickiel.plectrify.pkg.vst3"/>
    </choice>
    <choice id="au" visible="false">
        <pkg-ref id="io.github.patrickiel.plectrify.pkg.au"/>
    </choice>
    <pkg-ref id="io.github.patrickiel.plectrify.pkg.app" version="${version}">PlectrifyApp.pkg</pkg-ref>
    <pkg-ref id="io.github.patrickiel.plectrify.pkg.vst3" version="${version}">PlectrifyVst3.pkg</pkg-ref>
    <pkg-ref id="io.github.patrickiel.plectrify.pkg.au" version="${version}">PlectrifyAu.pkg</pkg-ref>
</installer-gui-script>
`,
);

const pkgName = `Plectrify-${version}-macos-arm64.pkg`;
const pkgPath = join(outputDir, pkgName);
rmSync(pkgPath, { force: true });

// Signed at product level with the Installer certificate — a different type
// from the Application one sealing the bundles. Ad-hoc has no counterpart for
// installer products, so that mode ships the pkg unsigned; the bundles inside
// carry their ad-hoc seals either way.
run('Building the installer pkg', 'productbuild', [
  '--distribution', join(pkgStage, 'distribution.xml'),
  '--package-path', pkgStage,
  ...(adHoc ? [] : ['--sign', installerIdentity, '--timestamp']),
  pkgPath,
]);

if (notarize) {
  run('Notarizing (this waits on Apple)', 'xcrun', [
    'notarytool', 'submit', pkgPath,
    '--keychain-profile', values['keychain-profile']!,
    '--wait',
  ]);
  run('Stapling the ticket', 'xcrun', ['stapler', 'staple', pkgPath]);
  run('Validating the staple', 'xcrun', ['stapler', 'validate', pkgPath]);
  // The end-to-end answer: would Gatekeeper accept this download?
  run('Gatekeeper assessment', 'spctl', ['-a', '-vv', '-t', 'install', pkgPath]);
}

const pkgHash = createHash('sha256').update(readFileSync(pkgPath)).digest('hex');
const checksumPath = join(outputDir, `${pkgName}.sha256`);
writeFileSync(checksumPath, `${pkgHash}  ${pkgName}\n`, 'ascii');

const manifestPath = join(outputDir, 'release-manifest-macos.json');
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      product: 'Plectrify',
      version,
      sourceCommit: commit,
      sourceBranch: branch,
      juceCommit,
      jucePatches: JUCE_PATCHES.map(({ patch }) => patch),
      binaryLicense: 'AGPL-3.0-only',
      platform: 'macos-arm64',
      installer: pkgName,
      sha256: pkgHash,
      sourceArchive: sourceArchiveName,
      sourceSha256: sourceArchiveHash,
      // Two facts rather than one: an ad-hoc build IS signed (its bundles
      // carry ad-hoc seals; the pkg around them is unsigned), and that is
      // precisely what Gatekeeper will not accept. Collapsing them into
      // `signed` made a provenance record that could not describe this mode.
      signature: adHoc ? 'ad-hoc' : 'developer-id',
      notarized: notarize,
    },
    null,
    2,
  )}\n`,
);

if (values['no-upload']) {
  console.log(`\nRelease rehearsal ready: ${pkgPath}`);
  console.log('Not uploaded (--no-upload). The real run produces a different pkg (signing timestamps), so never upload a rehearsal by hand.');
  process.exit(0);
}

// --clobber: re-running replaces this platform's assets on the pre-release,
// mirroring release.windows.ts's replace-a-prerelease loop, without touching the
// Windows assets or the notes. It can only ever be a pre-release — the gate
// above refuses a version that has been promoted.
run(`Uploading to the ${tag} release`, 'gh', [
  'release', 'upload', tag,
  pkgPath, checksumPath, manifestPath,
  '--repo', repoSlug, '--clobber',
]);
console.log(`\nPublished ${pkgName} on https://github.com/${repoSlug}/releases/tag/${tag}`);
if (adHoc) {
  console.log(
    '\nThis pkg is unsigned (its bundles are ad-hoc signed) and NOT notarized. Downloaded\n' +
      'through a browser it is quarantined and macOS refuses to open it — check the\n' +
      'release notes and the site\'s download page still carry the Open Anyway instructions.',
  );
}
console.log('Once both platforms are verified, promote with: pnpm release:promote (Windows box).');
