/**
 * Build a VST3 from its own permissively-licensed source and host the result.
 *
 *   # on Windows:
 *   pnpm --dir packaging build-plugin -- \
 *     --id neural-amp-modeler \
 *     --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
 *     --tag v0.7.15 \
 *     --vst3-sdk 58f8da7936800732561402d7936584ca4505de07
 *
 *   # on a Mac, same tag, same SDK pin, plus what xcodebuild needs:
 *   pnpm --dir packaging build-plugin -- \
 *     --id neural-amp-modeler \
 *     --repo https://github.com/sdatkinson/NeuralAmpModelerPlugin.git \
 *     --tag v0.7.15 --vst3-sdk 58f8da7936800732561402d7936584ca4505de07 \
 *     --project NeuralAmpModeler/projects/NeuralAmpModeler-macOS.xcodeproj \
 *     --scheme <vst3 scheme> --bundle NeuralAmpModeler.vst3
 *
 * ONE COMMAND, which builds this machine's platform and writes that platform's
 * `assets` entry. Both must be run, from the same tag and the same --vst3-sdk
 * pin, before publishing: a package's platforms share one `version`, so half a
 * release is not a release.
 *
 * HOW IT DIFFERS FROM host-plugin. That one re-hosts a binary somebody else
 * built, because their release ships it in a form that cannot be unzipped to a
 * VST3. This is for the harder case: upstream publishes no binary for this
 * platform at all, only source. Neural Amp Modeler went that way after v0.7.13
 * — its later tags are source-only and the author's own Windows builds moved to
 * "Gateway", a separately-copyrighted fork with no published licence that we
 * therefore cannot redistribute. Compiling the MIT source ourselves is the
 * clean answer: what we distribute is then a binary we built under a licence
 * that permits exactly that.
 *
 * The shared flow (clone at an exact tag, pin the SDK, validate, archive,
 * record, upload) is in buildPlugin.ts; the compilers are in
 * buildPlugin.windows.ts and buildPlugin.macos.ts.
 */
import { buildPlugin, fail, type BuildPluginPlatform } from './buildPlugin.ts';

const platforms: Record<string, () => Promise<Record<string, unknown>>> = {
  win32: () => import('./buildPlugin.windows.ts'),
  darwin: () => import('./buildPlugin.macos.ts'),
};

const load = platforms[process.platform];
if (!load) {
  fail(
    `there is no build route for ${process.platform}. Plectrify's catalogue offers windows-x64 and macos-arm64; run this on one of those.`,
  );
}

// Named per module rather than a shared `default` so that opening either file
// tells you which platform it is without reading the export.
const module = await load();
const impl = (module.windowsBuild ?? module.macosBuild) as BuildPluginPlatform;

await buildPlugin(impl);
