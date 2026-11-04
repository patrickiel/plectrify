import { describe, expect, it } from 'vitest';
import { describeSkipReason, isSkipReason } from './skippedPlugins';

describe('describeSkipReason', () => {
  it('offers a bridge for 32-bit plugins on Windows only', () => {
    expect(describeSkipReason('bits32', 'windows')).toContain('jBridge');
    expect(describeSkipReason('bits32', 'linux')).not.toContain('jBridge');
    expect(describeSkipReason('bits32', 'macos')).not.toContain('jBridge');
    expect(describeSkipReason('bits32')).not.toContain('jBridge');
  });

  it('names the Intel build on macOS and stays generic elsewhere', () => {
    expect(describeSkipReason('wrongArch', 'macos')).toContain('Apple Silicon');
    expect(describeSkipReason('wrongArch', 'windows')).not.toContain('Apple Silicon');
  });

  it('never names the plugin format', () => {
    for (const reason of ['bits32', 'wrongArch', 'other'])
      for (const platform of ['windows', 'macos', 'linux', undefined] as const)
        expect(describeSkipReason(reason, platform)).not.toMatch(/vst/i);
  });

  it('has a sentence for a reason it does not know', () => {
    expect(describeSkipReason('whatever')).toMatch(/could not load/);
  });

  it('recognises the two reasons the engine sends', () => {
    expect(isSkipReason('bits32')).toBe(true);
    expect(isSkipReason('wrongArch')).toBe(true);
    expect(isSkipReason('crashed')).toBe(false);
    expect(isSkipReason(undefined)).toBe(false);
  });
});
