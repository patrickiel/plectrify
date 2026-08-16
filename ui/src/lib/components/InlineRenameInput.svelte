<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import TextField from './TextField.svelte';
  import { selectOnMount, onEnterEscape } from './textInputBehaviors';

  /**
   * The one inline-rename input: mounts focused with its text selected,
   * commits on Enter or blur, cancels on Escape (claiming the key so a
   * surrounding Popover stays open). The host decides what "commit" means —
   * including whether an empty value is a reset or a no-op — and unmounts
   * this component afterwards; commit/cancel fire at most once between them,
   * so the blur that follows an Escape can't double-report.
   */
  interface Props {
    /** Initial text; the component owns the working copy while editing. */
    value: string;
    placeholder?: string;
    ariaLabel: string;
    /** Only what the host's layout needs — width, margins. The rename skin
        itself is TextField's, so the three call sites can no longer drift into
        three different-looking rename boxes. */
    class?: ClassValue;
    /** Reading size: `md` for a card title, `sm` inside a dense menu row. */
    size?: 'sm' | 'md';
    /** Called with the raw (untrimmed) text on Enter or blur. */
    onCommit: (value: string) => void;
    onCancel: () => void;
  }

  let {
    value,
    placeholder,
    ariaLabel,
    class: cls,
    size = 'md',
    onCommit,
    onCancel,
  }: Props = $props();

  // The prop only seeds the working copy — the host unmounts and remounts
  // this component per edit, so it never needs to track a changing `value`.
  // svelte-ignore state_referenced_locally
  let current = $state(value);
  let settled = false;

  function commit() {
    if (settled) return;
    settled = true;
    onCommit(current);
  }

  function cancel() {
    if (settled) return;
    settled = true;
    onCancel();
  }
</script>

<TextField
  {@attach selectOnMount}
  bind:value={current}
  {placeholder}
  {size}
  emphasis="editing"
  aria-label={ariaLabel}
  class={cls}
  onblur={commit}
  onkeydown={onEnterEscape(commit, cancel)}
/>
