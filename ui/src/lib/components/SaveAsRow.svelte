<script lang="ts">
  import { PlusIcon } from 'phosphor-svelte';
  import RowButton from './RowButton.svelte';
  import TextField from './TextField.svelte';
  import { onEnterEscape } from './textInputBehaviors';

  /**
   * The "Save current as…" footer row shared by the rig, scene and patch
   * menus: a button that swaps into a name input. Enter saves (an empty name
   * is passed through raw — every host falls back to its placeholder name),
   * Escape swaps back to the button without closing the surrounding menu.
   * Bind `editing` to reset the row when the menu re-opens.
   */
  interface Props {
    /** Whether the input is showing. Bindable so the host's onOpen can reset it. */
    editing?: boolean;
    label?: string;
    /** Suggested name, shown as the input placeholder. */
    placeholder: string;
    /** aria-label for the input: "Rig name", "Scene name", … */
    inputLabel: string;
    disabled?: boolean;
    /** Smaller type for the denser patch menu. */
    dense?: boolean;
    /** Called with the raw (possibly empty) name on Enter. */
    onSave: (name: string) => void;
  }

  let {
    editing = $bindable(false),
    label = 'Save current as…',
    placeholder,
    inputLabel,
    disabled = false,
    dense = false,
    onSave,
  }: Props = $props();

  let name = $state('');
  let input: HTMLInputElement | undefined = $state();

  const textSize = $derived(dense ? 'text-xs' : 'text-[0.8rem]');
  // bind:this on a component gives the instance, so TextField hands the node
  // back through a prop instead.

  function begin() {
    editing = true;
    name = '';
    queueMicrotask(() => input?.focus({ preventScroll: true }));
  }
</script>

{#if editing}
  <TextField
    bind:element={input}
    bind:value={name}
    size={dense ? 'sm' : 'md'}
    onkeydown={onEnterEscape(
      () => onSave(name),
      () => (editing = false),
    )}
    {placeholder}
    aria-label={inputLabel}
    class="w-full {textSize}"
  />
{:else}
  <RowButton class="w-full gap-1.5 px-3 {textSize}" {disabled} onclick={begin}>
    <PlusIcon size={13} />
    {label}
  </RowButton>
{/if}
