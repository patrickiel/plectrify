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
 * Plectrify-<version>-macos-arm64.dmg beside the Windows installer. Update
 * discovery reads only the release tag, so a second asset needs no app change.
 * Run order per release: pnpm release (Windows box) → pnpm release (Mac) →
 * pnpm release:promote (Windows box).
 *
 * One-time Mac setup (see RELEASING.md): an Apple Developer ID Application
 * certificate in the keychain, and a notarytool keychain profile:
 *   xcrun notarytool store-credentials plectrify --apple-id ... --team-id ...
 *
 * Signing gates that differ from Windows (which ships unsigned for now):
 * hardened runtime + notarization are the default here — Gatekeeper blocks an
 * unsigned download outright — and the entitlements in
 * cmake/Plectrify.entitlements (audio input, library validation off for
 * third-party VST3s) must ride the signature or the app is silent and
 * pluginless.
 *
 * --ad-hoc IS THE ONE PUBLISHABLE MODE THAT NEEDS NO APPLE ACCOUNT. Developer ID
 * signing and notarization both require a paid Apple Developer Program
 * membership; there is no free tier and no open-source exemption. Rather than
 * leave the Mac unreleasable until that is bought, --ad-hoc signs with the
 * ad-hoc identity (`-`), skips notarization, and is still allowed to upload.
 * What that costs is real and falls on the user, not on this script: the DMG
 * carries a quarantine flag when downloaded through a browser, and macOS
 * refuses a quarantined ad-hoc app with the words "Plectrify is damaged and
 * can't be opened" — a lie the install instructions have to pre-empt by name.
 * Recovering from it is System Settings -> Privacy & Security -> Open Anyway,
 * or `xattr -dr com.apple.quarantine`; distribution channels that do not set
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const notarize = !adHoc && !values['no-notarize'];

// --identity names a certificate; ad-hoc is the absence of one. Taking both
// would mean silently ignoring the one the command asked for by name.
if (adHoc && values.identity !== 'Developer ID Application') {
  fail(`--ad-hoc signs with no certificate, so it cannot also use --identity '${values.identity}'. Drop one.`);
}

// A rehearsal cannot be promoted by hand: notarization staples a ticket into
// the DMG, so an un-notarized rehearsal artifact differs from the real one.
// --ad-hoc is exempt because there the un-notarized DMG *is* the artifact —
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
        '  To publish without one, re-run with --ad-hoc — the DMG is then unnotarized, and macOS\n' +
        '  tells whoever downloads it that Plectrify "is damaged" until they clear the quarantine flag.',
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
  // immutable: people may already hold that DMG and the checksum published
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

This offer covers Plectrify itself. Plectrify ships one VST3 plugin, Neural Amp
Modeler, under the MIT licence; its source, the exact version, and where that
binary came from are recorded in THIRD_PARTY_NOTICES.md. At your request
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
const dmgName = `Plectrify-${version}-macos-arm64.dmg`;
const dmgPath = join(outputDir, dmgName);
rmSync(dmgPath, { force: true });

// Plain hdiutil rather than a DMG-decorating dependency: the artifact is the
// app; a background image is not worth a supply-chain edge.
run('Building the DMG', 'hdiutil', [
  'create', '-volname', `Plectrify ${version}`,
  '-srcfolder', app, '-format', 'UDZO', '-ov', dmgPath,
]);
// The DMG's own signature exists to be notarized; ad-hoc has nothing to submit
// it to, and an ad-hoc seal over a disk image tells a downloader nothing that
// the published SHA-256 does not already tell them. So it is signed in the
// Developer ID path only — the app inside is sealed either way.
if (!adHoc) {
  run('Codesigning the DMG', 'codesign', ['--force', '--timestamp', '--sign', identity, dmgPath]);
}

if (notarize) {
  run('Notarizing (this waits on Apple)', 'xcrun', [
    'notarytool', 'submit', dmgPath,
    '--keychain-profile', values['keychain-profile']!,
    '--wait',
  ]);
  run('Stapling the ticket', 'xcrun', ['stapler', 'staple', dmgPath]);
  run('Validating the staple', 'xcrun', ['stapler', 'validate', dmgPath]);
  // The end-to-end answer: would Gatekeeper accept this download?
  run('Gatekeeper assessment', 'spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmgPath]);
}

const dmgHash = createHash('sha256').update(readFileSync(dmgPath)).digest('hex');
const checksumPath = join(outputDir, `${dmgName}.sha256`);
writeFileSync(checksumPath, `${dmgHash}  ${dmgName}\n`, 'ascii');

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
      installer: dmgName,
      sha256: dmgHash,
      sourceArchive: sourceArchiveName,
      sourceSha256: sourceArchiveHash,
      // Two facts rather than one: an ad-hoc build IS signed, and that is
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
  console.log(`\nRelease rehearsal ready: ${dmgPath}`);
  console.log('Not uploaded (--no-upload). The real run produces a different DMG (signing timestamps), so never upload a rehearsal by hand.');
  process.exit(0);
}

// --clobber: re-running replaces this platform's assets on the pre-release,
// mirroring release.windows.ts's replace-a-prerelease loop, without touching the
// Windows assets or the notes. It can only ever be a pre-release — the gate
// above refuses a version that has been promoted.
run(`Uploading to the ${tag} release`, 'gh', [
  'release', 'upload', tag,
  dmgPath, checksumPath, manifestPath,
  '--repo', repoSlug, '--clobber',
]);
console.log(`\nPublished ${dmgName} on https://github.com/${repoSlug}/releases/tag/${tag}`);
if (adHoc) {
  console.log(
    '\nThis DMG is ad-hoc signed and NOT notarized. Downloaded through a browser it is\n' +
      'quarantined, and macOS reports "Plectrify is damaged and can\'t be opened" — check the\n' +
      'release notes and the site\'s download page still carry the Open Anyway instructions.',
  );
}
console.log('Once both platforms are verified, promote with: pnpm release:promote (Windows box).');
