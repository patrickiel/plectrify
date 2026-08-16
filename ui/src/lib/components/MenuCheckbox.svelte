<script lang="ts">
  import { CheckIcon } from 'phosphor-svelte';

  interface Props {
    checked: boolean;
    label: string;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
  }

  let { checked, label, onChange, disabled = false }: Props = $props();
</script>

<!-- Menu row with a check box drawn by us: the native control renders as a
     stark filled square that reads louder unchecked than checked. Here the
     unchecked state is a quiet outline. -->
<label
  class={[
    'group flex w-full items-center gap-2 rounded-control-xs px-3 py-1.5 text-left text-[.8rem] text-control-body',
    disabled ? 'cursor-default opacity-40' : 'cursor-pointer hover:bg-ink/10',
  ]}
>
  <input
    class="peer sr-only"
    type="checkbox"
    {checked}
    {disabled}
    onchange={(e) => onChange(e.currentTarget.checked)}
  />
  <span
    class={[
      'flex h-[.85rem] w-[.85rem] shrink-0 items-center justify-center rounded-[.2rem] border border-[color:color-mix(in_srgb,var(--color-ink)_calc(25%_*_var(--ink-k)),transparent)] bg-[color:color-mix(in_srgb,var(--color-void)_35%,transparent)] text-transparent [transition:border-color_120ms_ease,background-color_120ms_ease,color_120ms_ease] peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent',
      !disabled &&
        'group-hover:border-[color:color-mix(in_srgb,var(--color-ink)_calc(45%_*_var(--ink-k)),transparent)]',
    ]}
    aria-hidden="true"><CheckIcon size={10} weight="bold" /></span
  >
  {label}
</label>
