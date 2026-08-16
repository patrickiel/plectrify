/**
 * `window.devicePixelRatio` as reactive state.
 *
 * Windows applies a per-monitor scale factor (100%, 125%, 150%…), so dragging
 * the window to another display changes how many physical pixels a CSS pixel
 * covers — without a resize, a reload, or any event of its own. Anything that
 * aligns geometry to the pixel grid has to re-run when that happens, which is
 * the whole reason this exists.
 *
 * ```svelte
 * $effect(() => trackDevicePixelRatio());
 * const scale = $derived(devicePixelRatio() * zoom);
 * ```
 */

/** SSR-safe seed; `trackDevicePixelRatio` corrects it on the first run. */
let ratio = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
let trackers = 0;
let stop: (() => void) | undefined;

/** The current ratio. Reading this inside an effect or a derived subscribes. */
export function devicePixelRatio(): number {
  return ratio;
}

/**
 * Start watching, and return the matching teardown. Safe to call from several
 * places at once — the underlying listener is shared and torn down with the
 * last caller.
 */
export function trackDevicePixelRatio(): () => void {
  if (typeof window === 'undefined') return () => {};
  trackers += 1;
  if (trackers === 1) stop = watch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    trackers -= 1;
    if (trackers === 0) {
      stop?.();
      stop = undefined;
    }
  };
}

function watch(): () => void {
  let query: MediaQueryList | undefined;
  let disposed = false;

  // A resolution media query only reports when the value it was built with
  // stops matching, so each change has to re-arm the listener against the new
  // ratio. The `resize` fallback covers the case where a DPI change arrives as
  // a window resize instead — cheap, and it only ever re-reads one number.
  const rearm = () => {
    if (disposed) return;
    ratio = window.devicePixelRatio || 1;
    query?.removeEventListener('change', rearm);
    query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    query.addEventListener('change', rearm);
  };

  const onResize = () => {
    if (!disposed && window.devicePixelRatio !== ratio) rearm();
  };

  rearm();
  window.addEventListener('resize', onResize);

  return () => {
    disposed = true;
    query?.removeEventListener('change', rearm);
    window.removeEventListener('resize', onResize);
  };
}
