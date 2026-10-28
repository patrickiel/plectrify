/**
 * HTML5 drag-and-drop, replayed from mouse events, for the one web view where
 * the native kind cannot finish: WebKitGTK as JUCE embeds it on Linux.
 *
 * JUCE runs the web view in a GtkPlug embedded into its own X11 window over
 * XEmbed. A drag starts fine inside the page, but GTK hands the drop to XDND,
 * which resolves the target by *toplevel* window — and the toplevel under the
 * pointer is JUCE's, which is not XDND-aware. So the drag image follows the
 * pointer and the drop is simply lost. Nothing in a page handler can fix that.
 *
 * So the drag never leaves the page. The page's own `dragstart` handlers run
 * first and fill in the DataTransfer as usual; this then copies it, cancels the
 * native drag, and drives `dragenter`/`dragover`/`dragleave`/`drop`/`dragend`
 * itself from mouse events, with that same copied DataTransfer and the
 * browser's rules (a drop only lands where the last `dragover` was cancelled).
 * Every existing handler keeps working unchanged; none of them knows.
 *
 * Installed only where it is needed (see `needsPointerDragShim`): every other
 * engine finishes its own drags, and replacing a working native drag would
 * only lose the OS drag image.
 */

/** Whether this page is in WebKitGTK, i.e. Plectrify on Linux. */
export function needsPointerDragShim(userAgent: string): boolean {
  return /Linux/.test(userAgent) && !/Android|Chrome|Firefox/.test(userAgent);
}

/** How often `dragover` repeats while the pointer rests, as browsers do. */
const DRAGOVER_REPEAT_MS = 50;

interface Session {
  data: DataTransfer;
  source: Element;
  ghost: HTMLElement;
  offsetX: number;
  offsetY: number;
  over: Element | null;
  /** Whether the last `dragover` was cancelled, i.e. the target accepts. */
  accepted: boolean;
  x: number;
  y: number;
  repeat: ReturnType<typeof setInterval>;
}

function makeEvent(
  type: string,
  data: DataTransfer,
  x: number,
  y: number,
  relatedTarget: Element | null = null,
): DragEvent {
  const init = {
    bubbles: true,
    cancelable: type !== 'dragleave' && type !== 'dragend',
    composed: true,
    clientX: x,
    clientY: y,
    relatedTarget,
    dataTransfer: data,
  };
  const event =
    typeof DragEvent === 'function' ? new DragEvent(type, init) : new MouseEvent(type, init);
  // Older WebKit ignores `dataTransfer` in the init dictionary.
  if ((event as DragEvent).dataTransfer !== data) {
    Object.defineProperty(event, 'dataTransfer', { value: data });
  }
  return event as DragEvent;
}

/** A copy of the dragged element that follows the pointer — the drag image the
    cancelled native drag would have shown. Never a hit-test target. */
function makeGhost(source: Element): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement;
  const rect = source.getBoundingClientRect();
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    opacity: '0.85',
    zIndex: '2147483647',
  });
  ghost.removeAttribute('id');
  document.body.appendChild(ghost);
  return ghost;
}

export function installPointerDragShim(): () => void {
  let session: Session | null = null;

  const moveGhost = (s: Session) => {
    s.ghost.style.transform = `translate(${s.x - s.offsetX}px, ${s.y - s.offsetY}px)`;
  };

  const dragOver = (s: Session) => {
    const target = document.elementFromPoint(s.x, s.y);
    if (target !== s.over) {
      if (target) target.dispatchEvent(makeEvent('dragenter', s.data, s.x, s.y, s.over));
      if (s.over) s.over.dispatchEvent(makeEvent('dragleave', s.data, s.x, s.y, target));
      s.over = target;
    }
    if (!s.over) {
      s.accepted = false;
      return;
    }
    s.data.dropEffect = 'none';
    // dispatchEvent returns false when a handler called preventDefault().
    s.accepted = !s.over.dispatchEvent(makeEvent('dragover', s.data, s.x, s.y));
  };

  const finish = (dropped: boolean) => {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.repeat);
    s.ghost.remove();
    if (dropped && s.over && s.accepted) {
      s.over.dispatchEvent(makeEvent('drop', s.data, s.x, s.y));
    } else {
      if (s.over) s.over.dispatchEvent(makeEvent('dragleave', s.data, s.x, s.y));
      s.data.dropEffect = 'none';
    }
    s.source.dispatchEvent(makeEvent('dragend', s.data, s.x, s.y));
  };

  const onDragStart = (e: DragEvent) => {
    // Bubble phase on window: every handler on the dragged element has run.
    if (session || e.defaultPrevented || !e.dataTransfer || !(e.target instanceof Element)) return;

    const data = new DataTransfer();
    for (const type of e.dataTransfer.types) data.setData(type, e.dataTransfer.getData(type));
    data.effectAllowed = e.dataTransfer.effectAllowed;
    e.preventDefault(); // cancel the native drag; this one stays in the page

    const source = e.target;
    const rect = source.getBoundingClientRect();
    const s: Session = {
      data,
      source,
      ghost: makeGhost(source),
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      over: null,
      accepted: false,
      x: e.clientX,
      y: e.clientY,
      repeat: setInterval(() => session && dragOver(session), DRAGOVER_REPEAT_MS),
    };
    session = s;
    moveGhost(s);
    dragOver(s);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!session) return;
    // The button came up somewhere this page never heard about.
    if ((e.buttons & 1) === 0) return finish(false);
    session.x = e.clientX;
    session.y = e.clientY;
    moveGhost(session);
    dragOver(session);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!session) return;
    session.x = e.clientX;
    session.y = e.clientY;
    dragOver(session);
    finish(true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (session && e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  const onBlur = () => finish(false);

  window.addEventListener('dragstart', onDragStart);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur);

  return () => {
    finish(false);
    window.removeEventListener('dragstart', onDragStart);
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur);
  };
}
