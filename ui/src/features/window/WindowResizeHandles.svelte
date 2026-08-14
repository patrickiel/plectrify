<script lang="ts">
  import type { EngineBridge, WindowResizeEdge } from '../../lib/engine/EngineBridge';

  interface Props {
    engine: EngineBridge;
  }

  const { engine }: Props = $props();

  /** Grab-and-go: the OS takes over the drag after startWindowResize, so no
      pointer tracking happens here — just the initial pointer-down. */
  function grab(edge: WindowResizeEdge) {
    return (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      engine.startWindowResize(edge);
    };
  }
</script>

<!-- Invisible strips along the window edges that hand pointer-downs to the
     native resize loop. The webview otherwise swallows all mouse input, which
     would leave only the host's hairline border as a resize grab zone. The
     top edge is owned by the native title bar, so only the other edges need
     strips. Mouse-only affordances: keyboard resizing goes through the OS
     window menu, so these are hidden from the accessibility tree. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-y-0 left-0 z-[1000] w-1.5 cursor-ew-resize bg-transparent"
  onpointerdown={grab('left')}
></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-y-0 right-0 z-[1000] w-1.5 cursor-ew-resize bg-transparent"
  onpointerdown={grab('right')}
></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-x-0 bottom-0 z-[1000] h-1.5 cursor-ns-resize bg-transparent"
  onpointerdown={grab('bottom')}
></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed bottom-0 left-0 z-[1000] size-3.5 cursor-nesw-resize bg-transparent"
  onpointerdown={grab('bottom-left')}
></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed right-0 bottom-0 z-[1000] size-3.5 cursor-nwse-resize bg-transparent"
  onpointerdown={grab('bottom-right')}
></div>
