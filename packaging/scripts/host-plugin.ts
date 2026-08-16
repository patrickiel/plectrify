/**
 * Re-host a plugin whose upstream release cannot be unzipped to a VST3.
 *
 *   pnpm --dir packaging host-plugin -- \
 *     --id some-plugin --version 1.2.3 \
 *     --url https://upstream.example/SomePlugin-1.2.3.exe \
 *     --sha256 <hash of that download>
 *
 * ONE COMMAND, because the platform was never a choice — it is a fact about the
 * machine you are standing at, and the artefact it produces is that platform's
 * `assets` entry. Running it on Windows drives the upstream installer
 * (hostPlugin.windows.ts); running it on a Mac mounts the .dmg or .pkg
 * (hostPlugin.macos.ts). Neither is a variant of the other, and neither can
 * stand in for the other: the shared flow in hostPlugin.ts pins, stages,
 * archives, records and uploads identically for both.
 *
 * WHY IT IS A SCRIPT. Doing this by hand is a ritual nobody remembers six
 * months later, and it has to be repeated on every upstream release. Scripted,
 * a version bump is one command and the provenance record is written the same
 * way every time.
 */
import { fail, hostPlugin, type HostPluginPlatform } from './hostPlugin.ts';

const platforms: Record<string, () => Promise<{ default?: never } & Record<string, unknown>>> = {
  win32: () => import('./hostPlugin.windows.ts'),
  darwin: () => import('./hostPlugin.macos.ts'),
};

const load = platforms[process.platform];
if (!load) {
  fail(
    `there is no re-hosting route for ${process.platform}. Plectrify's catalogue offers windows-x64 and macos-arm64; run this on one of those.`,
  );
}

// Named per module rather than a shared `default` so that opening either file
// tells you which platform it is without reading the export.
const module = await load();
const impl = (module.windowsHost ?? module.macosHost) as HostPluginPlatform;

await hostPlugin(impl);
