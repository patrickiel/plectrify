/** A horizontal extent, in whichever coordinates it was measured. */
export interface HorizontalSpan {
  left: number;
  right: number;
}

/**
 * How far a slideout centred on its control must move to stay `margin` inside
 * `bounds`: zero when it already fits. A panel too wide to fit either way keeps
 * its left edge, which is where its captions start. All three arguments share
 * one coordinate system, and so does the answer.
 */
export function slideoutShift(
  panel: HorizontalSpan,
  bounds: HorizontalSpan,
  margin: number,
): number {
  if (panel.left < bounds.left + margin) return bounds.left + margin - panel.left;
  if (panel.right > bounds.right - margin) return bounds.right - margin - panel.right;
  return 0;
}
