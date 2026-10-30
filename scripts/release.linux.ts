/**
 * The Linux release pipeline: build, test and package Plectrify as a .deb, then
 * add it to the GitHub pre-release the Windows pipeline created. The twin of
 * release.macos.ts, and the same step in the same order — run at the tagged
 * commit, after the Windows step, before promotion:
 *
 * It is the `linux` job of .github/workflows/release.yml, reached through
 * `pnpm release` (release.ts), which refuses to run outside GitHub Actions.
 * --no-upload builds and packages without publishing.
 *
 * WHAT THE PACKAGE INSTALLS
 *
 *   /opt/plectrify/              the app: Plectrify, ui/, plugins/ (Neural Amp
 *                                Modeler), the licence, notices and source offer
 *   /usr/bin/plectrify           a link to it
 *   /usr/share/applications/     the desktop entry
 *   /usr/share/icons/hicolor/    the icon
 *   /usr/lib/vst3/Plectrify.vst3 the plugin, self-contained (ui/ and NAM under
 *                                Contents/Resources, the layout moduleResourceDir
 *                                resolves) — the machine-wide VST3 folder every
 *                                Linux host searches
 *   /var/lib/Plectrify           created 1777 by postinst: the shared content
 *                                root (CatalogueInstaller::contentRootDirectory)
 *
 * A .deb rather than an AppImage or a tarball for the same reason the Mac ships
 * a pkg rather than a DMG: something has to create directories outside the
 * user's home — the VST3 folder and the content root — and only an installer
 * running as root can. Removing the package leaves /var/lib/Plectrify alone,
 * like the Windows uninstaller leaves ProgramData: those are the user's
 * downloads.
 *
 * Neural Amp Modeler is not downloaded here as on the other platforms: Linux
 * builds its own (Source/namplugin, target PlectrifyNam_VST3) in this same
 * configure, so the bundled copy is always this commit's.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  JUCE_PATCHED_FILES, JUCE_PATCHES, ROOT, TEST_TARGETS, bundledPluginsMissingFor, capture, fail,
  pnpm, run,
} from './shared.ts';
import {
  IN_TREE_PLUGINS,
  appBinary,
  assertLinux,
  buildDir,
  buildTarget,
  configure,
  inTreePluginBundle,
  pluginBundle,
  writeHicolorIcons,
} from './linux.ts';

assertLinux('release.linux.ts');

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    'skip-tests': { type: 'boolean', default: false },
    'no-upload': { type: 'boolean', default: false },
  },
});

const CONFIG = 'Release';
const PLATFORM = 'linux-x64';

if (values['skip-tests'] && !values['no-upload']) {
  fail('--skip-tests cannot publish; pair it with --no-upload. Run the full suite before uploading.');
}

// --- Version, tree, licence: the same gates as the other two pipelines ------
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

// Byte-exact canonical AGPLv3, same pin as the other release scripts.
const licenseBytes = readFileSync(join(ROOT, 'LICENSE'));
const licenseHash = createHash('sha256').update(licenseBytes).digest('hex');
if (
  licenseBytes.length !== 34523
  || licenseHash !== '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0'
) {
  fail('LICENSE is not the complete canonical 34,523-byte GNU AGPLv3 document.');
}

// A shipped plugin this platform neither downloads nor builds would leave the
// app without something it assumes is there.
const unshippable = bundledPluginsMissingFor(PLATFORM).filter((p) => !(p.id in IN_TREE_PLUGINS));
if (unshippable.length > 0) {
  fail(`no ${PLATFORM} build of ${unshippable.map((p) => p.name).join(', ')} (packaging/bundled-plugins.json).`);
}

if (!existsSync(join(ROOT, 'packaging/node_modules'))) {
  pnpm('Installing packaging tooling', ['--dir', join(ROOT, 'packaging'), 'install', '--frozen-lockfile']);
}
pnpm('Validating the plugin catalogue', ['--dir', join(ROOT, 'packaging'), 'validate']);

// --- The tag must exist and name this commit --------------------------------
const tag = `v${version}`;
const repoSlug = (() => {
  const origin = capture('git', ['-C', ROOT, 'remote', 'get-url', 'origin']).trim();
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(origin);
  if (!match) fail(`could not derive a GitHub owner/name from the origin remote '${origin}'.`);
  return `${match[1]}/${match[2]}`;
})();

let sourceArchiveHash = '';
if (!values['no-upload']) {
  // Peel an annotated tag to its commit; see release.macos.ts for why the
  // first ls-remote line is not the answer.
  const refs = capture('git', ['-C', ROOT, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && /^[0-9a-f]{40}$/i.test(parts[0]!));
  const refCommit = (name: string) => refs.find((parts) => parts[1] === name)?.[0] ?? '';
  const taggedCommit = refCommit(`refs/tags/${tag}^{}`) || refCommit(`refs/tags/${tag}`);

  if (taggedCommit === '') {
    fail(`no remote tag ${tag}. Publish the Windows pre-release first — it creates the tag, the GitHub release and the corresponding-source archive this package rides with.`);
  }
  if (taggedCommit.toLowerCase() !== commit.toLowerCase()) {
    fail(`remote tag ${tag} names ${taggedCommit}, but this checkout is at ${commit}. Check out the release commit.`);
  }

  const json = capture('gh', ['release', 'view', tag, '--repo', repoSlug, '--json', 'isPrerelease']);
  if (json.trim() === '') {
    fail(`could not read a GitHub release for ${tag} — publish the Windows pre-release first, and check that gh is authenticated.`);
  }
  if ((JSON.parse(json) as { isPrerelease?: boolean }).isPrerelease !== true) {
    fail(`release ${tag} has already been promoted to latest, and a promoted version is immutable. Bump VERSION and release again.`);
  }

  sourceArchiveHash = capture('gh', [
    'release', 'download', tag, '--repo', repoSlug,
    '--pattern', `Plectrify-${version}-source.zip.sha256`, '--output', '-',
  ]).trim().split(/\s+/)[0] ?? '';
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
// A release tree starts clean: incremental builds can link stale objects
// against changed headers (see the AGENTS.md note on header-inline code).
rmSync(buildDir(CONFIG), { recursive: true, force: true });
configure(CONFIG);
buildTarget(CONFIG, 'Plectrify');
buildTarget(CONFIG, 'PlectrifyPlugin_VST3');
for (const { target } of Object.values(IN_TREE_PLUGINS)) buildTarget(CONFIG, target);
if (!values['skip-tests']) {
  for (const target of TEST_TARGETS) buildTarget(CONFIG, target);
  run('Running native tests', 'ctest', ['--test-dir', buildDir(CONFIG), '--output-on-failure']);
}

const app = appBinary(CONFIG);
if (!existsSync(app)) fail(`release app was not produced at ${app}.`);
const vst3Built = pluginBundle(CONFIG);
if (!existsSync(join(vst3Built, 'Contents/x86_64-linux/Plectrify.so'))) {
  fail(`release VST3 was not produced at ${vst3Built}.`);
}

// --- The published source must be the exact patched tree built from --------
const juceCommitPin = (() => {
  const cmake = readFileSync(join(ROOT, 'CMakeLists.txt'), 'utf8');
  const match = /GIT_TAG\s+([0-9a-f]{40})/i.exec(cmake);
  if (!match) fail('could not read the pinned JUCE commit from CMakeLists.txt.');
  return match[1]!.toLowerCase();
})();
const juceSource = join(buildDir(CONFIG), '_deps/juce-src');
const juceCommit = capture('git', ['-C', juceSource, 'rev-parse', 'HEAD']).trim().toLowerCase();
if (juceCommit !== juceCommitPin) {
  fail(`expected JUCE commit ${juceCommitPin}, but the release build used '${juceCommit}'.`);
}
for (const { patch, file, marker } of JUCE_PATCHES) {
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

// --- Stage the package tree --------------------------------------------------
const outputDir = join(ROOT, 'artifacts');
const stage = join(outputDir, 'deb-stage');
rmSync(stage, { recursive: true, force: true });

const optDir = join(stage, 'opt/plectrify');
mkdirSync(optDir, { recursive: true });
copyFileSync(app, join(optDir, 'Plectrify'));
chmodSync(join(optDir, 'Plectrify'), 0o755);

/** What the app and the plugin each carry as read-only resources: the UI, the
    bundled plugins, and the documents that travel with a binary. */
function stageResources(resources: string): void {
  mkdirSync(resources, { recursive: true });
  cpSync(join(ROOT, 'ui/dist'), join(resources, 'ui'), { recursive: true });
  for (const { bundle } of Object.values(IN_TREE_PLUGINS)) {
    cpSync(inTreePluginBundle(CONFIG, bundle), join(resources, 'plugins', bundle), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  copyFileSync(join(ROOT, 'LICENSE'), join(resources, 'LICENSE'));
  copyFileSync(join(juceSource, 'LICENSE.md'), join(resources, 'JUCE_LICENSE.md'));
  copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'));
  writeFileSync(join(resources, 'SOURCE_OFFER.txt'), sourceOffer());
  writeFileSync(join(resources, 'BUILD_INFO.txt'), buildInfo());
}

function sourceOffer(): string {
  const url = `https://github.com/${repoSlug}/releases/download/${tag}/Plectrify-${version}-source.zip`;
  return `CORRESPONDING SOURCE FOR PLECTRIFY ${version}

Plectrify is distributed under the GNU Affero General Public License, version 3
only. The complete corresponding source used to build this binary, including
the exact patched JUCE source tree, is published beside the installers:

${url}
${sourceArchiveHash ? `\nSHA-256: ${sourceArchiveHash}\n` : ''}
This offer covers Plectrify itself — the standalone application and the
Plectrify VST3 plug-in this package installs, which are builds of the same
AGPLv3 source. Both host VST3 plug-ins and are built against Steinberg's VST3
SDK as bundled with JUCE, which Plectrify uses under the SDK's GPLv3 option; see
THIRD_PARTY_NOTICES.md.

The Neural Amp Modeler this package ships is Plectrify's own Linux build of that
project's MIT-licensed DSP; its source is part of the archive above
(Source/namplugin) together with the exact third-party commits it compiles,
recorded in CMakeLists.txt and THIRD_PARTY_NOTICES.md.
`;
}

function buildInfo(): string {
  return `Plectrify release
Version: ${version}
Git commit: ${commit}
Git branch: ${branch}
JUCE commit: ${juceCommit} (JUCE 8.0.14)
Plectrify licence: GNU AGPL version 3 only
Corresponding source: Plectrify-${version}-source.zip
`;
}

// The app resolves resources beside its executable (moduleResourceDir).
stageResources(optDir);

// The plugin: a copy of the built bundle, with the same resources under
// Contents/Resources, which moduleResourceDir maps x86_64-linux/ to.
const vst3Staged = join(stage, 'usr/lib/vst3/Plectrify.vst3');
mkdirSync(join(vst3Staged, '..'), { recursive: true });
cpSync(vst3Built, vst3Staged, { recursive: true, verbatimSymlinks: true });
stageResources(join(vst3Staged, 'Contents/Resources'));

mkdirSync(join(stage, 'usr/bin'), { recursive: true });
symlinkSync('/opt/plectrify/Plectrify', join(stage, 'usr/bin/plectrify'));

mkdirSync(join(stage, 'usr/share/applications'), { recursive: true });
writeFileSync(
  join(stage, 'usr/share/applications/plectrify.desktop'),
  `[Desktop Entry]
Type=Application
Name=Plectrify
GenericName=Guitar Rig
Comment=Play your guitar through a chain of VST3 amps and effects
Exec=/opt/plectrify/Plectrify
Icon=plectrify
Terminal=false
Categories=AudioVideo;Audio;Music;
StartupWMClass=Plectrify
`,
);
writeHicolorIcons(join(ROOT, 'Assets/PlectrifyIcon.png'), join(stage, 'usr/share/icons/hicolor'));

// --- Package metadata ---------------------------------------------------------
const debian = join(stage, 'DEBIAN');
mkdirSync(debian, { recursive: true });
const installedKb = Number(capture('du', ['-sk', '--exclude=DEBIAN', stage]).split(/\s+/)[0] ?? 0);

// Each runtime library under both its pre- and post-t64 name (Ubuntu 24.04
// renamed them for the 64-bit time_t transition), so one package installs on
// either side of it. WebKitGTK and curl are what NEEDS_WEB_BROWSER/NEEDS_CURL
// link; JACK is dlopened and therefore only recommended.
writeFileSync(
  join(debian, 'control'),
  `Package: plectrify
Version: ${version}
Section: sound
Priority: optional
Architecture: amd64
Maintainer: Plectrify <hello@plectrify.com>
Homepage: https://plectrify.com
Installed-Size: ${installedKb}
Depends: libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2, libcurl4t64 | libcurl4, libfreetype6, libfontconfig1, libx11-6, libxext6, libxrandr2, libxinerama1, libxcursor1
Recommends: pipewire-jack | libjack-jackd2-0
Description: Guitar-rig host for VST3 amps and effects
 Plectrify runs a chain of VST3 plugins live from a guitar input, with
 knob mapping, rigs, a tuner and TONE3000 captures. Installs the
 standalone application and the Plectrify VST3 plug-in.
`,
);
writeFileSync(
  join(debian, 'postinst'),
  `#!/bin/sh
set -e
# The shared content root: fixed, so patch packs' baked paths resolve on every
# machine, and writable by every account without elevation, sticky so each can
# remove only what it owns — the mode /Users/Shared carries on macOS.
install -d -m 1777 /var/lib/Plectrify
chmod 1777 /var/lib/Plectrify
exit 0
`,
);
chmodSync(join(debian, 'postinst'), 0o755);

// --- Build the .deb ------------------------------------------------------------
const debName = 'Plectrify-linux-x64.deb';
const debPath = join(outputDir, debName);
rmSync(debPath, { force: true });
run('Building the .deb', 'dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, debPath]);

const debHash = createHash('sha256').update(readFileSync(debPath)).digest('hex');
const checksumPath = join(outputDir, `${debName}.sha256`);
writeFileSync(checksumPath, `${debHash}  ${debName}\n`, 'ascii');

const manifestPath = join(outputDir, 'release-manifest-linux.json');
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
      platform: PLATFORM,
      installer: debName,
      sha256: debHash,
      sourceArchive: `Plectrify-${version}-source.zip`,
      sourceSha256: sourceArchiveHash,
    },
    null,
    2,
  )}\n`,
);

if (values['no-upload']) {
  console.log(`\nRelease build ready: ${debPath}`);
  console.log('Not uploaded (--no-upload). Install it with: sudo apt install ' + debPath);
  process.exit(0);
}

// --clobber replaces this platform's assets on the pre-release only; the gate
// above refuses a promoted version.
run(`Uploading to the ${tag} release`, 'gh', [
  'release', 'upload', tag,
  debPath, checksumPath, manifestPath,
  '--repo', repoSlug, '--clobber',
]);
console.log(`\nPublished ${debName} on https://github.com/${repoSlug}/releases/tag/${tag}`);
