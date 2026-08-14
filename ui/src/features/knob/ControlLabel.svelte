<script lang="ts">
  import { tooltip } from '../../lib/components/tooltip.svelte';

  interface Props {
    label: string;
    onRename?: (label: string) => void;
  }

  let { label, onRename }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  function start() {
    if (!onRename) return;
    draft = label;
    editing = true;
  }

  function commit() {
    if (!editing) return;
    editing = false;
    if (draft !== label) onRename?.(draft);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault(); // commit instead of inserting a newline
      commit();
    } else if (e.key === 'Escape') {
      editing = false; // discard
    }
  }
</script>

{#if editing}
  <!-- Focus + select the text as soon as the input mounts. -->
  <textarea
    {@attach (el) => el.select()}
    class="block field-sizing-content w-full max-w-full resize-none overflow-hidden rounded-sm border border-accent bg-[color-mix(in_srgb,var(--color-void)_90%,transparent)] px-0.5 py-px text-center font-[inherit] text-[.65rem] leading-[1.4] font-bold tracking-[1px] [overflow-wrap:anywhere] text-ink uppercase shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent)_30%,transparent)] outline-none [html[data-theme='light']_&]:bg-menu"
    rows="1"
    value={draft}
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commit}
    onkeydown={onKey}
    aria-label="Rename {label}"></textarea>
{:else}
  <button
    type="button"
    class={[
      'line-clamp-3 max-w-full cursor-default overflow-hidden border border-transparent bg-transparent px-0.5 py-px font-[inherit] text-[.65rem] leading-[1.4] font-bold tracking-[1px] [overflow-wrap:anywhere] text-muted uppercase',
      onRename && 'cursor-text transition-colors duration-200 hover:text-accent',
    ]}
    onclick={start}
    disabled={!onRename}
    {@attach tooltip(onRename ? 'Click to rename' : undefined)}
  >
    {label}
  </button>
{/if}
