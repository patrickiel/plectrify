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

<!-- Both states share one grid cell and are always rendered, the inactive one
     hidden and inert: the row is then as tall as the taller of the two in
     either state, and the input stretches to the button's height, so nothing
     below the row moves when it swaps (issue #45). Swapping one element for
     the other let each size itself, and they never agreed. -->
<div class="grid">
  <RowButton
    class={['col-start-1 row-start-1 w-full gap-1.5 px-3', textSize, editing && 'invisible']}
    {disabled}
    inert={editing}
    onclick={begin}
  >
    <PlusIcon size={13} />
    {label}
  </RowButton>
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
    inert={!editing}
    class={['col-start-1 row-start-1 w-full', textSize, !editing && 'invisible']}
  />
</div>
