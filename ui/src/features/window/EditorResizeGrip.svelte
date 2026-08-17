<script lang="ts">
  import type { EngineBridge } from '../../lib/engine/EngineBridge';
  import { grippedSize, type GripStart } from './editorSize';

  interface Props {
    engine: EngineBridge;
  }

  const { engine }: Props = $props();

  /** Unlike WindowResizeHandles' grab-and-go, the whole drag happens here:
      a DAW-hosted editor has no OS sizing loop to hand the pointer to, so
      the grip tracks it and streams the wanted size over the bridge. One
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

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // window.innerWidth/Height are the editor's size: the page fills it, and
    // the grip mounts outside every --ui-scale zoom wrapper, so CSS pixels
    // and editor points are the same space.
    start = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    latest = { x: e.clientX, y: e.clientY };
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

<!-- The plugin window's resize grip, drawn by the page because nothing else
     can offer one: the DAW owns the window frame, but AUv2 gives a host no
     way to learn the view is resizable, so no AU host lets the frame be
     dragged — and JUCE's own corner grip sits beneath the native web view.
     Visible, unlike the standalone's strips: a frame that will not respond
     needs the affordance to say where resizing lives. Mouse-only, like the
     strips: there is no keyboard path to a DAW window's geometry either. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed right-0 bottom-0 z-[1000] flex size-5 cursor-nwse-resize items-end justify-end p-0.5 text-muted opacity-50 hover:opacity-100"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
  </svg>
</div>
