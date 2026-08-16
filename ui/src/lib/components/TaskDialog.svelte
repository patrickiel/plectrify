<script lang="ts">
  import { CheckCircleIcon } from 'phosphor-svelte';
  import DialogShell from './DialogShell.svelte';

  interface Props {
    state?: 'working' | 'complete';
    title: string;
    description: string;
    statusText?: string;
    progress?: number;
    actionLabel?: string;
    closeLabel?: string;
    /** Extra classes on the centering overlay (see DialogShell). */
    overlayClass?: string;
    onClose?: () => void;
  }

  let {
    state = 'working',
    title,
    description,
    statusText,
    progress,
    actionLabel = 'Done',
    closeLabel = 'Close dialog',
    overlayClass = '',
    onClose,
  }: Props = $props();

  const dismissible = $derived(state === 'complete' && !!onClose);
  const progressPercent = $derived(
    progress === undefined ? undefined : Math.min(100, Math.max(0, progress)),
  );

  function close() {
    if (dismissible) onClose?.();
  }
</script>

<DialogShell
  labelledBy="task-dialog-title"
  describedBy="task-dialog-description"
  onDismiss={dismissible ? close : undefined}
  dismissLabel={closeLabel}
  showCloseX={state === 'complete'}
  {overlayClass}
>
  <div class="px-7 pt-8 pb-7 text-center">
    <!-- No spinner while working: the progress bar below already says the task
         is running, and two things animating for one fact is one too many. The
         finished state keeps its mark, which the bar cannot express. -->
    {#if state === 'complete'}
      <div
        class="mx-auto grid size-16 place-items-center rounded-full border border-accent/25 bg-accent/8 shadow-(--shadow-glow-accent-lg)"
      >
        <CheckCircleIcon class="text-accent" size={34} weight="fill" />
      </div>
    {/if}

    <!-- The title carries a plugin name that changes on every step of a load,
         so its length is out of our hands. Reserve two lines and centre the
         text inside them: a name that wraps costs no extra height, and the
         card keeps one size instead of resizing under the user's eyes. -->
    <h2
      id="task-dialog-title"
      class="flex min-h-14 items-center justify-center text-lg font-semibold text-balance text-ink"
      class:mt-5={state === 'complete'}
    >
      <span class="line-clamp-2" {title}>{title}</span>
    </h2>
    <p id="task-dialog-description" class="mt-2 text-sm leading-6 text-muted">{description}</p>

    {#if state === 'working'}
      <div class="mt-6 h-1 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
        {#if progressPercent === undefined}
          <div
            class="task-progress h-full w-1/3 rounded-full bg-accent shadow-(--shadow-glow-accent-bar)"
          ></div>
        {:else}
          <div
            class="h-full rounded-full bg-accent shadow-(--shadow-glow-accent-bar) transition-[width] duration-300"
            style:width={`${progressPercent}%`}
          ></div>
        {/if}
      </div>
      {#if statusText}
        <p
          class="mt-3 font-mono text-[10px] tracking-[0.22em] text-accent uppercase"
          role="status"
          aria-live="polite"
        >
          {statusText}
        </p>
      {/if}
    {:else if onClose}
      <button
        type="button"
        class="mt-7 min-w-28 cursor-pointer rounded-[6px] border border-[color:color-mix(in_srgb,var(--color-ink)_calc(25%_*_var(--ink-k)),transparent)] bg-ink/5 px-4 py-2 text-[.85rem] font-medium text-ink backdrop-blur-[10px] outline-none [transition:all_.25s_cubic-bezier(.25,.8,.25,1)] hover:border-accent hover:bg-accent/10 hover:text-accent hover:shadow-[var(--shadow-glow-accent-sm),inset_0_0_8px_color-mix(in_srgb,var(--color-accent)_10%,transparent)] focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-out)] active:scale-[.98] active:shadow-[0_0_5px_color-mix(in_srgb,var(--color-accent)_20%,transparent)]"
        onclick={close}>{actionLabel}</button
      >
    {/if}
  </div>
</DialogShell>

<style>
  .task-progress {
    animation: task-progress 1.15s ease-in-out infinite alternate;
  }

  @keyframes task-progress {
    from {
      transform: translateX(-20%);
    }
    to {
      transform: translateX(220%);
    }
  }
</style>
