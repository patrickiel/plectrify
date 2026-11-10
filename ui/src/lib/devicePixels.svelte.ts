import { createSubscriber } from 'svelte/reactivity';

/**
 * `window.devicePixelRatio` as a reactive read.
 *
 * Windows applies a per-monitor scale factor (100%, 125%, 150%…), so dragging
 * the window to another display changes how many physical pixels a CSS pixel
 * covers — without a resize, a reload, or any event of its own. Anything that
 * aligns geometry to the pixel grid has to re-run when that happens, which is
 * the whole reason this exists.
 *
 * ```svelte
 * const scale = $derived(devicePixelRatio() * zoom);
 * ```
 *
 * Reading it inside an effect or a derived subscribes; the listeners are
 * shared between every reader and torn down with the last one
 * (`createSubscriber`), so a consumer needs no effect of its own. Read
 * anywhere else, it is just the current value.
 */
export function devicePixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  subscribe();
  return window.devicePixelRatio || 1;
}

const subscribe = createSubscriber((update) => {
  let query: MediaQueryList | undefined;
  let ratio = 0;

  // A resolution media query only reports when the value it was built with
  // stops matching, so each change has to re-arm the listener against the new
  // ratio. The `resize` fallback covers the case where a DPI change arrives as
  // a window resize instead — cheap, and it only ever re-reads one number.
  const rearm = () => {
    ratio = window.devicePixelRatio || 1;
    query?.removeEventListener('change', onChange);
    query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    query.addEventListener('change', onChange);
  };

  const onChange = () => {
    rearm();
    update();
  };

  const onResize = () => {
    if (window.devicePixelRatio !== ratio) onChange();
  };

  rearm();
  window.addEventListener('resize', onResize);

  return () => {
    query?.removeEventListener('change', onChange);
    window.removeEventListener('resize', onResize);
  };
});
