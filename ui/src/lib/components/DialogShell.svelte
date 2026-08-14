<script lang="ts">
  import { XIcon } from 'phosphor-svelte';
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { fade } from 'svelte/transition';

  /**
   * The modal scaffolding shared by every dialog: the full-screen scrim, the
   * accent hairline, the rounded card, Escape-to-dismiss and the top-right
   * close button. Hosts render their body as children and keep their own ids
   * for the aria wiring. Omitting `onDismiss` locks the dialog open (a task
   * mid-flight): the scrim disables and Escape does nothing.
   */
  interface Props {
    role?: 'dialog' | 'alertdialog';
    labelledBy: string;
    describedBy?: string;
    /** Called by Escape, the scrim and the close button. */
    onDismiss?: () => void;
    /** aria-label for the scrim and close button. */
    dismissLabel?: string;
    /** Show the top-right X (needs `onDismiss` to do anything). */
    showCloseX?: boolean;
    /** Card size/layout classes; the chrome itself is fixed. */
    cardClass?: string;
    /** Extra classes on the centering overlay (e.g. vertical padding). */
    overlayClass?: string;
    children: Snippet;
  }

  let {
    role = 'dialog',
    labelledBy,
    describedBy,
    onDismiss,
    dismissLabel = 'Close dialog',
    showCloseX = false,
    cardClass = 'max-w-md',
    overlayClass = '',
    children,
  }: Props = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onDismiss?.();
  }

  /**
   * A dialog arrives and leaves; unlike a tool panel's progressive disclosure
   * (see `createReveal`), it *should* animate the moment it is created, since
   * that creation is the event. The scrim fades on its own so the page behind
   * dims and blurs before the card is asked to be read, and the card rises the
   * last few pixels into place rather than being stamped onto the screen.
   *
   * Both are `|global`: the `{#if}` that shows a dialog lives in the host, not
   * here, so a local transition on this component's own elements would have no
   * block of its own being created or destroyed and would never play.
   *
   * Leaving is quicker than arriving — a dismissed dialog is already spent, and
   * making the user watch it retreat at the same pace reads as lag.
   */
  const motion = (ms: number) => (prefersReducedMotion.current ? 0 : ms);

  function card(_node: Element, { duration }: { duration: number }) {
    return {
      duration: motion(duration),
      easing: cubicOut,
      css: (t: number, u: number) =>
        `opacity: ${t}; transform: translateY(${u * 8}px) scale(${0.96 + 0.04 * t});`,
    };
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="absolute inset-0 z-[60] grid place-items-center px-6 {overlayClass}">
  <button
    type="button"
    class="absolute inset-0 h-full w-full bg-scrim backdrop-blur-md disabled:cursor-default"
    disabled={!onDismiss}
    onclick={() => onDismiss?.()}
    aria-label={dismissLabel}
    in:fade|global={{ duration: motion(180), easing: cubicOut }}
    out:fade|global={{ duration: motion(130), easing: cubicOut }}
  ></button>
  <div
    class="relative z-10 w-full overflow-hidden rounded-2xl border border-ink/10 bg-menu shadow-dialog {cardClass}"
    in:card|global={{ duration: 200 }}
    out:card|global={{ duration: 130 }}
    {role}
    aria-modal="true"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
  >
    <div class="h-px bg-gradient-to-r from-transparent via-accent to-transparent opacity-70"></div>
    {#if showCloseX}
      <button
        type="button"
        class="absolute top-4 right-4 grid size-9 place-items-center rounded-lg text-muted transition hover:bg-ink/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onclick={() => onDismiss?.()}
        aria-label={dismissLabel}
      >
        <XIcon size={18} />
      </button>
    {/if}
    {@render children()}
  </div>
</div>
