/** Pure formatters for the engine performance readout. */

/** RAM in MB below 1 GB, one-decimal GB above; "—" when unknown. */
export function formatRamMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Total round-trip latency in milliseconds; unavailable with no audio device. */
export function formatLatencyMs(samples: number, sampleRate: number): string {
  if (!Number.isFinite(samples) || samples < 0 || !Number.isFinite(sampleRate) || sampleRate <= 0)
    return '—';
  return `${((samples / sampleRate) * 1000).toFixed(1)} ms`;
}
