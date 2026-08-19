<script lang="ts">
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import { grippedSize, type EditorResizeEdge, type GripStart } from './editorSize';

  interface Props {
    engine: EngineBridge;
  }

  const { engine }: Props = $props();

  /** Unlike WindowResizeHandles' grab-and-go, the whole drag happens here:
      a DAW-hosted editor has no OS sizing loop to hand the pointer to, so
      the handles track it and stream the wanted size over the bridge. One
      send per animation frame — each one is a native window resize. */
  let start: GripStart | null = null;
  let latest = { x: 0, y: 0 };
  let frame = 0;

  function send() {
    frame = 0;
    if (start) engine.setEditorSize(...toSizeArgs());
  }

  function toSizeArgs(): [number, number] {
    const size = grippedSize(start!, latest);
    return [size.width, size.height];
  }

  function down(edge: EditorResizeEdge) {
    return (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      // window.innerWidth/Height are the editor's size: the page fills it, and
      // the handles mount outside every --ui-scale zoom wrapper, so CSS pixels
      // and editor points are the same space.
      start = {
        edge,
        pointerX: e.clientX,
        pointerY: e.clientY,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      latest = { x: e.clientX, y: e.clientY };
    };
  }

  function move(e: PointerEvent) {
    if (!start) return;
    latest = { x: e.clientX, y: e.clientY };
    if (frame === 0) frame = requestAnimationFrame(send);
  }

  function up() {
    if (!start) return;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    // The final position lands even if its frame never fired.
    engine.setEditorSize(...toSizeArgs());
    start = null;
  }
</script>

<!-- The plugin window's resize handles, drawn by the page because the DAW's
     own frame is all there otherwise is: a hairline border the page's web
     view abuts, which swallows every pointer event a pixel inside it. That is
     the same reason the standalone draws WindowResizeHandles over its own
     edges — but those hand the drag to the OS sizing loop, which a hosted
     editor has none of, so these track the pointer and drive setEditorSize.
     The AU needs them for a second reason: AUv2 gives a host no way to learn
     the view is resizable, so no AU host offers the border drag at all.

     Right and bottom only. A plugin may ask its host for a size and nothing
     more, so a left or top drag could not hold the opposite edge still — it
     would grow the window rightwards as the pointer went left. The host's own
     border still resizes from those edges wherever it offers one.

     Mouse-only, like the standalone's strips: there is no keyboard path to a
     DAW window's geometry either. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed top-0 right-0 bottom-5 z-[1000] w-1.5 cursor-ew-resize bg-transparent"
  onpointerdown={down('right')}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed right-5 bottom-0 left-0 z-[1000] h-1.5 cursor-ns-resize bg-transparent"
  onpointerdown={down('bottom')}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
></div>

<!-- The corner is the only visible one, and the only one that is an
     affordance rather than a wider target: a frame that may not respond needs
     something to say where resizing lives. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed right-0 bottom-0 z-[1000] flex size-5 cursor-nwse-resize items-end justify-end p-0.5 text-muted opacity-50 hover:opacity-100"
  onpointerdown={down('bottom-right')}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
  </svg>
</div>
