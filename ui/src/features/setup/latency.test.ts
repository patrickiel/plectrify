import { describe, expect, it } from 'vitest';
import { describeBufferSize, formatMs, latencyMilliseconds, latencyVerdict } from './latency';

describe('latencyMilliseconds', () => {
  it('converts a round trip at the device rate', () => {
    expect(latencyMilliseconds(480, 48000)).toBeCloseTo(10);
    expect(latencyMilliseconds(0, 48000)).toBe(0);
  });

  it('reports nothing rather than dividing by a rate it does not have', () => {
    // -1 is the engine's "no device open"; a rate of 0 is a device that has not
    // said yet. Neither is a latency of infinity.
    expect(latencyMilliseconds(-1, 48000)).toBe(0);
    expect(latencyMilliseconds(480, 0)).toBe(0);
  });
});

describe('latencyVerdict', () => {
  it('splits at the two thresholds that matter to playing', () => {
    expect(latencyVerdict(5)).toBe('imperceptible');
    expect(latencyVerdict(6.9)).toBe('imperceptible');
    expect(latencyVerdict(7)).toBe('comfortable');
    expect(latencyVerdict(14.9)).toBe('comfortable');
    expect(latencyVerdict(15)).toBe('noticeable');
    expect(latencyVerdict(40)).toBe('noticeable');
  });
});

describe('describeBufferSize', () => {
  it('leads with samples and explains in milliseconds', () => {
    expect(describeBufferSize(128, 48000)).toBe('128 samples · 2.7 ms');
    expect(describeBufferSize(512, 44100)).toBe('512 samples · 12 ms');
  });

  it('drops the milliseconds when no device has named a rate', () => {
    expect(describeBufferSize(128, 0)).toBe('128 samples');
  });
});

describe('formatMs', () => {
  it('shows a decimal only where one carries information', () => {
    expect(formatMs(2.68)).toBe('2.7');
    expect(formatMs(9.94)).toBe('9.9');
    expect(formatMs(21.3)).toBe('21');
  });
});
