<script lang="ts">
  import { DotsSixVerticalIcon } from 'phosphor-svelte';
  import { cn } from './classNames';
  import type { VerticalReorder } from './verticalReorder.svelte';
  import { tooltip } from './tooltip.svelte';

  interface Props {
    reorder: VerticalReorder;
    /** Position of this row in the list. */
    index: number;
    /** Row count, so the arrow keys know where the list ends. */
    count: number;
    /** Names the row in the handle's accessible label. */
    label: string;
  }

  let { reorder, index, count, label }: Props = $props();
</script>

<!-- Grip for the drag gesture in `VerticalReorder`. Also a real button: arrow
     keys step the row up and down, so reordering works without a pointer. -->
<button
  type="button"
  class={cn(
    'flex shrink-0 cursor-grab touch-none items-center py-1.5 pr-0.5 pl-1.5 text-muted opacity-45 [transition:opacity_120ms_ease,color_120ms_ease] hover:text-accent hover:opacity-100 focus-visible:text-accent focus-visible:opacity-100 focus-visible:[outline:var(--focus-ring)] focus-visible:[outline-offset:var(--focus-in)]',
    reorder.from === index && 'cursor-grabbing text-accent opacity-100',
  )}
  aria-label="Reorder {label}"
  {@attach tooltip('Drag to reorder')}
  onpointerdown={(e) => reorder.start(e, index)}
  onpointermove={(e) => reorder.move(e)}
  onpointerup={(e) => reorder.end(e)}
  onpointercancel={() => reorder.cancel()}
  onlostpointercapture={() => reorder.cancel()}
  onkeydown={(e) => reorder.keydown(e, index, count)}
>
  <DotsSixVerticalIcon size={14} weight="bold" />
</button>
