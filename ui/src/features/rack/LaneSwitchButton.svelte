<script lang="ts">
  import { CircleNotchIcon } from 'phosphor-svelte';
  import IconButton from '../../lib/components/IconButton.svelte';

  interface Props {
    /** Lane letter shown on the exclusive split switch. */
    label: string;
    active: boolean;
    /** The engine is still switching to this lane; show a spinner meanwhile. */
    pending?: boolean;
    onSelect: () => void;
  }

  let { label, active, pending = false, onSelect }: Props = $props();

  // Match the lane tag in the edit-mode mixer: long names step the type down
  // rather than spilling out of the button.
  const fontSize = $derived(
    label.length <= 2 ? '0.9375rem' : label.length <= 5 ? '0.78rem' : '0.68rem',
  );
</script>

<IconButton
  variant="canvas"
  label={`Select lane ${label}`}
  tip={`Switch to lane ${label}`}
  class="relative z-[2] w-max px-[0.3rem] font-mono font-bold tracking-[1.4px] whitespace-nowrap"
  style={`font-size: ${fontSize}`}
  onclick={onSelect}
  aria-pressed={active}
  aria-busy={pending}
>
  {#if pending}
    <CircleNotchIcon class="animate-spin text-accent" size={16} weight="bold" />
  {:else}
    {label}
  {/if}
</IconButton>
