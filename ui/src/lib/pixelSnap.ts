/**
 * Aligning CSS geometry to whole device pixels.
 *
 * A hairline drawn at a fractional device offset is antialiased across two or
 * three rows instead of painting one crisp band, which is why a nominally 2px
 * line looks different on a 100% display than on a 125% one. These helpers
 * convert a nominal length or centre into the nearest value that lands on the
 * physical pixel grid.
 *
 * All inputs and outputs are *local* CSS pixels — the units a length is written
 * in at its use site. `scale` carries every factor between there and the screen
 * (`devicePixelRatio` times any CSS `zoom` on an ancestor), so callers inside a
 * zoomed subtree pass the combined figure and keep writing plain lengths.
 */

/** A scale of 0 or NaN would blank every line it sizes, so fall back to 1:1. */
function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function safeValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Device pixels per local CSS pixel inside a subtree scaled by CSS `zoom`. */
export function deviceScale(devicePixelRatio: number, zoom: number): number {
  return safeScale(safeScale(devicePixelRatio) * safeScale(zoom));
}

/**
 * The closest local length to `nominal` that covers a whole number of device
 * pixels. Ties round up — a glowing signal line reads better a touch heavy than
 * a touch thin — so at devicePixelRatio 1.25 a nominal 2px becomes 3 device
 * pixels (2.4 local px) rather than 2. Clamped to a one-device-pixel hairline so
 * a heavily zoomed-out rack still draws something.
 */
export function snapThickness(nominal: number, scale: number): number {
  const s = safeScale(scale);
  return Math.max(1, Math.round(safeValue(nominal) * s)) / s;
}

/** The closest local position whose device coordinate is a whole number. */
export function snapEdge(value: number, scale: number): number {
  const s = safeScale(scale);
  return Math.round(safeValue(value) * s) / s;
}

/**
 * Snap the centre of a band so that *both* its edges land on device pixels: an
 * even-width band needs a whole device coordinate, an odd-width one a half.
 * Snapping the centre as if it were an edge would leave odd-width bands
 * straddling two rows at half coverage each.
 *
 * `origin` is where the box this coordinate is measured from sits, in device
 * pixels. Pass it whenever the result is painted by something that antialiases
 * rather than snaps — an SVG stroke inherits its element's sub-pixel position,
 * so a centre snapped only against its own local origin still feathers. Blink
 * re-snaps CSS boxes on its own, so for those it only matters that they end up
 * on the *same* grid as the strokes they join.
 */
export function snapCenter(center: number, scale: number, thickness: number, origin = 0): number {
  const s = safeScale(scale);
  const half = (safeValue(thickness) * s) / 2;
  const device = safeValue(origin) + safeValue(center) * s;
  return (Math.round(device - half) + half - safeValue(origin)) / s;
}
