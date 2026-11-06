<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /**
   * Dropping onto something that is already there: a module card in the rack
   * (a tile replaces it, another module swaps with it) or the Hidden plugins
   * card in Settings. One look, so a drop reads the same wherever it lands.
   *
   * It covers its positioned parent and is mounted by the caller only while a
   * drag is in flight, so exactly one element sees the drag: whatever is
   * underneath can neither swallow the drop nor fire a dragleave as the pointer
   * crosses it. The drag handlers arrive as ordinary attributes.
   *
   * It speaks the rack gaps' language (dashed accent at rest, solid and lit where
   * the drop would land) plus the one thing a gap never has to say: something
   * already here is answering for it. Hence the veil — without it a ring around a
   * card reads as "add inside".
   *
   * A sibling of the thing it covers, never a child: the pill straddles the top
   * edge, and a `Card` clips its contents. `--drop-overlay-radius` follows the
   * corners of what is underneath.
   */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** The drag is over this target: releasing here would land. */
    over: boolean;
    /** A drop this target cannot take. Left mounted and made transparent to the
        drag rather than removed, so the pointer falls through to something with
        no drop handler and the browser draws its own "no" — the same answer,
        without a ring that would have promised otherwise. */
    blocked?: boolean;
    /** What the drop would do, in a word and an icon. */
    children: Snippet;
  }

  let { over, blocked = false, children, ...rest }: Props = $props();
</script>

<div
  {...rest}
  class="drop-overlay"
  class:drop-overlay-over={over}
  class:drop-overlay-blocked={blocked}
  role="presentation"
>
  <span class="drop-overlay-badge" aria-hidden="true">{@render children()}</span>
</div>

<style>
  .drop-overlay {
    position: absolute;
    inset: 0;
    /* Above a module card's own hover lift (z-index 50 on .module-editing:hover),
       which a drag started elsewhere can leave latched. */
    z-index: 60;
    border-radius: var(--drop-overlay-radius, 1rem);
    border: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;
  }
  .drop-overlay-over {
    border-style: solid;
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-void) 62%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent),
      0 0 18px color-mix(in srgb, var(--color-accent) 28%, transparent);
  }
  .drop-overlay-blocked {
    opacity: 0;
    pointer-events: none;
  }
  /* Straddling the top edge rather than centred: the drag image is drawn on the
     pointer, which is somewhere in the middle of the target the whole time it is
     hovered, and a short target has no middle to spare. The drag image says what
     is arriving; this says what happens to it. */
  .drop-overlay-badge {
    position: absolute;
    top: 0;
    left: 50%;
    translate: -50% -50%;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    /* Never the event target: a child under the pointer fires the zone's own
       dragleave, which would flicker the ring off the moment it appeared. */
    pointer-events: none;
    padding: 0.22rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 20%, var(--color-menu));
    color: var(--color-accent);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    /* Only the hovered target names the gesture; every other one is a ring and
       nothing more, or the rack fills with the same word repeated. */
    opacity: 0;
    scale: 0.9;
    transition:
      opacity 0.15s ease,
      scale 0.15s ease;
  }
  .drop-overlay-over .drop-overlay-badge {
    opacity: 1;
    scale: 1;
  }
</style>
