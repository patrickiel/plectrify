<script lang="ts">
  import { onMount } from 'svelte';
  import type { StatusState } from '../../lib/engine/types';
  import { formatLatencyMs, formatRamMb } from './formatStats';

  interface Props {
    status: StatusState;
  }

  let { status }: Props = $props();

  // The engine streams cpuLoad at 15 Hz, which makes the digits flicker.
  // Sample at ~4 Hz through an exponential moving average so the readout
  // glides; RAM rides the same relaxed cadence. Sampling lives and dies with
  // this component: it only exists while the Info panel shows it, so closing
  // the panel is what stops the polling.
  let smoothedCpuLoad = $state(0);
  let smoothedRamMb = $state(0);
  let cpuEma: number | undefined;

  const cpuPercent = $derived(Math.round(smoothedCpuLoad * 100));
  const ram = $derived(formatRamMb(smoothedRamMb));
  const totalLatency = $derived(formatLatencyMs(status.totalLatencySamples, status.sampleRate));

  function sample() {
    const load = Math.max(0, Math.min(1, status.cpuLoad));
    cpuEma = cpuEma === undefined ? load : cpuEma + 0.5 * (load - cpuEma);
    smoothedCpuLoad = cpuEma;
    smoothedRamMb = status.processRamMb;
  }

  // onMount rather than $effect: sampling is paced by the interval alone —
  // the 15 Hz status stream must not re-trigger it — and nothing here reacts.
  onMount(() => {
    sample();
    const sampleTimer = setInterval(sample, 250);
    return () => clearInterval(sampleTimer);
  });
</script>

<div
  class="grid grid-cols-[auto_1fr] gap-x-[.6rem] gap-y-[.15rem] font-mono text-[.72rem] leading-[1.3] font-[650] whitespace-nowrap text-muted tabular-nums"
>
  <span
    class="tracking-[.08em] text-[color:color-mix(in_srgb,var(--color-muted)_calc(78%_*_var(--ink-k)),transparent)]"
    >CPU</span
  >
  <span
    class={cpuPercent >= 90
      ? 'text-left text-danger'
      : cpuPercent >= 70
        ? 'text-left text-hot'
        : 'text-left text-[color:color-mix(in_srgb,var(--color-ink)_calc(74%_*_var(--ink-k)),transparent)]'}
  >
    {cpuPercent}%
  </span>
  <span
    class="tracking-[.08em] text-[color:color-mix(in_srgb,var(--color-muted)_calc(78%_*_var(--ink-k)),transparent)]"
    >RAM</span
  >
  <span
    class="text-left text-[color:color-mix(in_srgb,var(--color-ink)_calc(74%_*_var(--ink-k)),transparent)]"
    >{ram}</span
  >
  <span
    class="tracking-[.08em] text-[color:color-mix(in_srgb,var(--color-muted)_calc(78%_*_var(--ink-k)),transparent)]"
    >LAT</span
  >
  <span
    class="text-left text-[color:color-mix(in_srgb,var(--color-ink)_calc(74%_*_var(--ink-k)),transparent)]"
    >{totalLatency}</span
  >
</div>
