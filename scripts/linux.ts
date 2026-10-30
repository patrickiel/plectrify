/**
 * Linux plumbing for run.linux.ts and release.linux.ts: where the build lives,
 * how the app is stopped, started and staged. The platform-neutral spawn
 * helpers live in shared.ts; this is the twin of macos.ts, and like it carries
 * none of Windows' hazards (MSBuild .tlog staleness, the WebView2 profile
 * lock) — WebKitGTK keeps no per-profile lock a dead process can leak.
 *
 * The layout is Windows' rather than the Mac's: a bare executable with ui/ and
 * plugins/ staged beside it (moduleResourceDir), not a bundle.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { ROOT, capture, fail, run } from './shared.ts';

export function assertLinux(script: string): void {
  if (process.platform !== 'linux') {
    fail(`${script} is the Linux path. On Windows or macOS use the matching counterpart.`);
  }
}

/** One build tree per configuration: Ninja and Makefiles are single-config,
    exactly as on the Mac. */
export function buildDir(config: string): string {
  return join(ROOT, `build-linux-${config.toLowerCase()}`);
}

/** JUCE inserts a $<CONFIG> segment even under single-config generators
    (JUCEUtils.cmake's products_folder). */
export function appBinary(config: string): string {
  return join(buildDir(config), 'Plectrify_artefacts', config, 'Plectrify');
}

/** Shipped plugins that Linux builds from this tree rather than downloads,
    keyed by their packaging/bundled-plugins.json id. Neural Amp Modeler is the
    one: upstream's iPlug2 build has no Linux target, so Source/namplugin wraps
    the same DSP in a JUCE VST3 (see CMakeLists.txt). */
export const IN_TREE_PLUGINS: Record<string, { target: string; bundle: string }> = {
  'neural-amp-modeler': { target: 'PlectrifyNam_VST3', bundle: 'NeuralAmpModeler.vst3' },
};

export function inTreePluginBundle(config: string, bundle: string): string {
  return join(buildDir(config), 'PlectrifyNam_artefacts', config, 'VST3', bundle);
}

export function pluginBundle(config: string): string {
  return join(buildDir(config), 'PlectrifyPlugin_artefacts', config, 'VST3', 'Plectrify.vst3');
}

/** The machine-wide content root (CatalogueInstaller::contentRootDirectory).
    The installer creates it; a dev machine has to, once, by hand. */
export const CONTENT_ROOT = '/var/lib/Plectrify';

/** Configure, and refuse early with the one apt line that fixes it when a
    system library JUCE needs on Linux is missing — CMake's own pkg-config error
    names a module, not a package, and arrives after JUCE has been cloned. */
export function configure(config: string): void {
  assertBuildDependencies();
  const generator = capture('which', ['ninja']).trim() !== '' ? ['-G', 'Ninja'] : [];
  run(`Configuring (${config})`, 'cmake', [
    '-B', buildDir(config),
    '-S', ROOT,
    `-DCMAKE_BUILD_TYPE=${config}`,
    ...generator,
  ]);
}

/** pkg-config module → the Debian/Ubuntu package that provides it. JUCE's
    Linux backends: WebKitGTK + GTK for the web view, ALSA for audio, curl for
    HTTPS, freetype/fontconfig for text, plus the X11 headers its windowing
    includes directly (they have no pkg-config module, so they are checked by
    header). JACK is dlopened at run time and needs only its header. */
const PKG_CONFIG_DEPS: [module: string, aptPackage: string][] = [
  ['webkit2gtk-4.1', 'libwebkit2gtk-4.1-dev'],
  ['gtk+-3.0', 'libgtk-3-dev'],
  ['alsa', 'libasound2-dev'],
  ['libcurl', 'libcurl4-openssl-dev'],
  ['freetype2', 'libfreetype-dev'],
  ['fontconfig', 'libfontconfig-dev'],
];

const HEADER_DEPS: [header: string, aptPackage: string][] = [
  ['/usr/include/X11/Xlib.h', 'libx11-dev'],
  ['/usr/include/X11/extensions/Xrandr.h', 'libxrandr-dev'],
  ['/usr/include/X11/extensions/Xinerama.h', 'libxinerama-dev'],
  ['/usr/include/X11/Xcursor/Xcursor.h', 'libxcursor-dev'],
  ['/usr/include/X11/extensions/XShm.h', 'libxext-dev'],
  ['/usr/include/X11/extensions/Xcomposite.h', 'libxcomposite-dev'],
  ['/usr/include/jack/jack.h', 'libjack-jackd2-dev'],
  ['/usr/include/GL/gl.h', 'libgl-dev'],
];

const TOOLS: [tool: string, aptPackage: string][] = [
  ['cmake', 'cmake'],
  ['pkg-config', 'pkg-config'],
  ['g++', 'build-essential'],
  ['git', 'git'],
];

export function assertBuildDependencies(): void {
  const missing = new Set<string>();

  for (const [tool, pkg] of TOOLS) {
    if (capture('which', [tool]).trim() === '') missing.add(pkg);
  }
  const havePkgConfig = capture('which', ['pkg-config']).trim() !== '';
  for (const [module, pkg] of PKG_CONFIG_DEPS) {
    if (!havePkgConfig || spawnSync('pkg-config', ['--exists', module]).status !== 0) missing.add(pkg);
  }
  for (const [header, pkg] of HEADER_DEPS) {
    if (!existsSync(header)) missing.add(pkg);
  }

  if (missing.size > 0) {
    fail(
      'missing build dependencies. Install them with:\n\n' +
        `  sudo apt install ${[...missing].sort().join(' ')} ninja-build\n`,
    );
  }
}

/** Warn — never fail — when the shared content root is not there to install
    into. Everything but content packages and TONE3000 downloads works without
    it, and the dev loop should not demand sudo before it will build. */
export function checkContentRoot(): void {
  let ok = false;
  try {
    ok = statSync(CONTENT_ROOT).isDirectory();
    accessSync(CONTENT_ROOT, constants.W_OK);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn(
      `\nwarning: ${CONTENT_ROOT} is missing or not writable, so content packages and TONE3000\n` +
        '         downloads cannot install. The installer creates it; on a dev machine, once:\n\n' +
        `           sudo install -d -m 1777 ${CONTENT_ROOT}\n`,
    );
  }
}

export function buildTarget(config: string, target: string, cleanFirst = false): void {
  run(`Building ${target} (${config})`, 'cmake', [
    '--build', buildDir(config),
    '--target', target,
    ...(cleanFirst ? ['--clean-first'] : []),
  ]);
}

/** Ask any running instance to die and wait until it is gone, so the linker
    can overwrite the binary and a relaunch never races the outgoing process.
    Matched by exact process name, so the WebKit helper processes — which
    die with their parent — are not what is waited on. */
export async function stopApp(): Promise<void> {
  spawnSync('pkill', ['-x', 'Plectrify']);
  for (let i = 0; i < 100; i++) {
    if (spawnSync('pgrep', ['-x', 'Plectrify']).status !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('a Plectrify process is still running and would not exit. Quit it and retry.');
}

/** Launch the app and confirm it is still alive a moment later, so a startup
    crash is reported rather than printed as "Launching..." and exit 0. */
export async function startApp(
  config: string,
  extraEnv: Record<string, string> = {},
  note = '',
): Promise<void> {
  const binary = appBinary(config);
  console.log(`==> Launching ${binary}${note}`);

  const child = spawn(binary, [], {
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);

  if (exited) {
    fail(
      'Plectrify exited immediately after launch. Run the binary from a terminal to see why:\n' +
        `  ${binary}\n` +
        "A crash leaves a core with systemd-coredump ('coredumpctl list Plectrify') or under /var/crash.",
    );
  }
}

/** Stage ui/dist beside the executable, where moduleResourceDir() looks in a
    Release build. Debug serves the source tree's ui/dist directly. */
export function stageUiBesideBinary(config: string): void {
  if (config === 'Debug') return;

  const dist = join(ROOT, 'ui/dist');
  if (!existsSync(join(dist, 'index.html'))) {
    fail('ui/dist is missing — build the UI first (rerun without --no-ui).');
  }

  const target = join(appBinary(config), '..', 'ui');
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true });
}

/**
 * Writes the app icon into a hicolor theme tree (`<share>/icons/hicolor`) at
 * every size from 512 down to 16, each halved from the one above.
 *
 * A theme lookup only searches the directories its index.theme declares, and
 * hicolor's stop at 512x512: the 1024 px art installed as-is was in a folder
 * nothing looks in, so GNOME drew its generic gear. Halving rather than one
 * resample per size keeps this a box filter with no image library — the art is
 * 1024 px, so every step is exact.
 */
export function writeHicolorIcons(source: string, hicolor: string): void {
  let image = decodeRgbaPng(readFileSync(source));
  if (image.width !== 1024 || image.height !== 1024) {
    fail(`${source} must be 1024x1024 (is ${image.width}x${image.height}).`);
  }
  while (image.width > 16) {
    image = halve(image);
    const dir = join(hicolor, `${image.width}x${image.width}`, 'apps');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plectrify.png'), encodeRgbaPng(image));
  }
}

interface RgbaImage { width: number; height: number; pixels: Uint8Array }

function decodeRgbaPng(png: Buffer): RgbaImage {
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // 8-bit RGBA, not interlaced: what the art is, and all this reads.
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        fail('The app icon must be an 8-bit, non-interlaced RGBA PNG.');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = (raw[row + x]! + predicted) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** Averages each 2x2 block, weighting colour by alpha so transparent edges do not darken. */
function halve({ width, height, pixels }: RgbaImage): RgbaImage {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = ((2 * y + dy) * width + 2 * x + dx) * 4;
        const alpha = pixels[i + 3]!;
        r += pixels[i]! * alpha;
        g += pixels[i + 1]! * alpha;
        b += pixels[i + 2]! * alpha;
        a += alpha;
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { width: w, height: h, pixels: out };
}

function encodeRgbaPng({ width, height, pixels }: RgbaImage): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  // Every row unfiltered (filter byte 0): a few kilobytes larger, nothing to get wrong.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
