<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';
  import { cn } from './classNames';

  /**
   * The panel card: the bordered surface a tool panel groups related controls
   * into — the looper's transport, its setup rows, its session archive.
   *
   * A card is what separates one group from the next: the border around it does
   * that job on its own, so rows *inside* a card are told apart by their own
   * padding and hover, never by a hairline. A card therefore carries no padding
   * of its own — each row pads itself.
   *
   * It keeps flexbox's default `min-height: auto`, so a card given `flex-1`
   * fills the panel but never shrinks below its own content — the card clips,
   * and clipped rows would just vanish. Whichever part of the card is meant to
   * give way (a scrolling list) says so itself.
   */
  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
    class?: ClassValue;
    children: Snippet;
  }

  let { class: className, children, ...rest }: Props = $props();
</script>

<div
  {...rest}
  class={cn(
    'flex flex-col overflow-hidden rounded-control-lg border border-control-edge-hair bg-control-rest',
    className,
  )}
>
  {@render children()}
</div>
