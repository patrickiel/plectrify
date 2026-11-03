import type { PluginPlatform } from './legacyPlugins';

/**
 * Why the scanner skipped a plugin file it found, as the engine reports it
 * (`BlacklistedPlugin.reason`). Only reasons the engine can state with
 * confidence from the file's own header reach here — see PluginBinary.h;
 * anything it cannot explain is simply not listed.
 */
export type SkipReason = 'bits32' | 'wrongArch';

export function isSkipReason(value: unknown): value is SkipReason {
  return value === 'bits32' || value === 'wrongArch';
}

/**
 * One sentence for the Skipped plugins dialog. Names the format by nothing
 * but the fact — 32-bit, another processor — and offers the way out where one
 * exists: a bridge on Windows, nothing on Linux (where none is in common
 * use), and on macOS the explanation that the Intel build is the problem.
 */
export function describeSkipReason(reason: string, platform?: PluginPlatform): string {
  switch (reason) {
    case 'bits32':
      return platform === 'windows'
        ? 'A 32-bit plugin. Plectrify is 64-bit, so it cannot load it directly; a bridge such as jBridge can.'
        : 'A 32-bit plugin. Plectrify is 64-bit, so it cannot load it.';
    case 'wrongArch':
      return platform === 'macos'
        ? 'Built for Intel Macs only. Plectrify runs natively on Apple Silicon, so it cannot load it.'
        : 'Built for a different processor than this computer has, so it cannot load.';
    default:
      return 'Plectrify could not load this plugin.';
  }
}
