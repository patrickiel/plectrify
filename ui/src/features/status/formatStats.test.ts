import { describe, expect, it } from 'vitest';
import { formatLatencyMs, formatRamMb } from './formatStats';

describe('formatRamMb', () => {
  it('switches units at 1 GB and marks unknown values', () => {
    expect(formatRamMb(0)).toBe('—');
    expect(formatRamMb(480.4)).toBe('480 MB');
    expect(formatRamMb(1536)).toBe('1.5 GB');
    expect(formatRamMb(NaN)).toBe('—');
  });
});

describe('formatLatencyMs', () => {
  it('formats total samples at the active sample rate and marks unavailable values', () => {
    expect(formatLatencyMs(384, 48000)).toBe('8.0 ms');
    expect(formatLatencyMs(-1, 48000)).toBe('—');
  });
});
