<script lang="ts">
  import Button from './Button.svelte';

  /**
   * A Cancel + destructive-action pair that takes over a menu row, so the
   * thing being confirmed stays in view and the row's normal action can't be
   * hit mid-confirm. `stacked` puts the message above the buttons (RigBar's
   * "New rig" discard prompt); the default lays everything out on one line.
   */
  interface Props {
    message: string;
    /** The destructive verb: "Delete", "Discard". */
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** Smaller type for the denser patch menu. */
    dense?: boolean;
    /** Message above the buttons instead of inline with them. */
    stacked?: boolean;
  }

  let {
    message,
    confirmLabel,
    onConfirm,
    onCancel,
    dense = false,
    stacked = false,
  }: Props = $props();

  const messageText = $derived(dense ? 'text-xs' : 'text-[0.8rem]');
  const buttonText = $derived(dense ? 'text-[0.7rem]' : 'text-[0.75rem]');
</script>

{#if stacked}
  <div class="px-3 py-1.5 {messageText}">
    <p class="text-ink/80">{message}</p>
    <div class="mt-1.5 flex gap-1">
      <Button variant="ghost" size="sm" class="flex-1" onclick={onCancel}>Cancel</Button>
      <Button variant="ghost" size="sm" tone="warn" class="flex-1" onclick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  </div>
{:else}
  <div class="flex w-full items-center gap-1 py-0.5 pr-1 pl-3">
    <span class="min-w-0 flex-1 truncate {messageText} text-ink/80">{message}</span>
    <Button variant="ghost" size="sm" class="shrink-0 {buttonText}" onclick={onCancel}>
      Cancel
    </Button>
    <Button variant="ghost" size="sm" tone="warn" class="shrink-0 {buttonText}" onclick={onConfirm}>
      {confirmLabel}
    </Button>
  </div>
{/if}
