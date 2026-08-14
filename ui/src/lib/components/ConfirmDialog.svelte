<script lang="ts">
  import DialogShell from './DialogShell.svelte';

  interface Props {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** Extra classes on the centering overlay, e.g. to hold the scrim off chrome. */
    overlayClass?: string;
  }

  let {
    title,
    description,
    confirmLabel,
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel,
    overlayClass = '',
  }: Props = $props();
</script>

<DialogShell
  role="alertdialog"
  labelledBy="confirm-dialog-title"
  describedBy="confirm-dialog-description"
  onDismiss={onCancel}
  dismissLabel={cancelLabel}
  {overlayClass}
>
  <div class="px-7 pt-8 pb-7 text-center">
    <h2 id="confirm-dialog-title" class="text-lg font-semibold text-ink">{title}</h2>
    <p id="confirm-dialog-description" class="mt-2 text-sm leading-6 text-muted">{description}</p>

    <div class="mt-7 flex justify-center gap-2">
      <button
        type="button"
        class="min-w-28 rounded-lg border border-ink/15 px-4 py-2 text-sm text-ink/80 transition hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onclick={onCancel}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        class="min-w-28 rounded-lg border border-warn/40 px-4 py-2 text-sm text-warn transition hover:bg-warn/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn"
        onclick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</DialogShell>
