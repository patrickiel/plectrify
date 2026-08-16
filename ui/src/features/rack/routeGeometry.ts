/**
 * Geometry for the rack's green signal routes.
 *
 * Four different painters draw one continuous-looking line: the serial trunk
 * and each lane line are CSS boxes, the split/merge fans are SVG strokes, and
 * the add-lane stem is a pair of borders. They only read as one line if they
 * agree to the pixel, so every coordinate here is snapped onto the physical
 * pixel grid before it reaches any of them.
 *
 * Two rules make that work. Everything is snapped in `.rack-flow` coordinates
 * rather than each box's own, because rounding two boxes independently against
 * their own origins is exactly what puts a route one device pixel above the one
 * it joins. And lengths that are meant to *overlap* a neighbour (arm endpoints,
 * the stem's top) are deliberately left long, since a shared edge between an
 * antialiased stroke and a snapped border box can still show a hairline seam.
 */
import { snapCenter, snapEdge } from '../../lib/pixelSnap';

/** Nominal route weight. The grid rounds it to whole device pixels. */
export const ROUTE_THICKNESS = 2;

/** Mirrors `.split-routes { grid-template-columns: 2rem … }` and
    `.split-actions { left: 2rem }` — the fan and the stem are anchored to the
    same column, which is what makes them collinear. Also the width to assume
    for a fan whose column has not been measured yet. */
export const FAN_COLUMN_PX = 32;

/** Mirrors `.split-stem { bottom: -1.75rem }`: how far below the routes box the
    stem's elbow sits. */
const STEM_ELBOW_BELOW_ROUTES_PX = 28;

/** Where along the connector column each fan turns, and how round the turn is.
    Ratios rather than lengths so a wider column spreads the same shape. */
const SPLIT_JUNCTION_RATIO = 0.38;
const MERGE_JUNCTION_RATIO = 0.62;
const ELBOW_RADIUS_RATIO = 0.44;
const MAX_ELBOW_RADIUS = 20;

export interface RouteGrid {
  /** Device pixels per local css pixel: devicePixelRatio x rack zoom. */
  scale: number;
  /** Route weight in local css px, already snapped to whole device pixels. */
  thickness: number;
}

/** `.rack-flow`, the box every route in the chain is snapped against: its height
    in local css px, and where its top edge lands in device px. */
export interface FlowMetrics {
  height: number;
  originY: number;
}

/** Straight off the DOM, in local css px, unsnapped. Lane and box positions are
    relative to `.rack-flow` so they can all be snapped against one origin. */
export interface RawRouteGeometry {
  /** `.lane-connector` width — the horizontal span each fan covers. */
  width: number;
  /** `.split-routes` height, and its top within `.rack-flow`. */
  height: number;
  top: number;
  /** `.rack-flow` height. The trunk and every fan sit on its centre. */
  flowHeight: number;
  /** Each `.lane-row`'s top and centre within `.rack-flow`. */
  laneTops: number[];
  laneCenters: number[];
  /** Where these boxes actually sit on the screen, in device pixels: the top of
      `.rack-flow`, and the left edge of each fan. Auto-margin centring routinely
      leaves them on a half pixel, and an SVG stroke inherits that offset — so
      without it the fans feather while the CSS lines beside them stay hard. */
  originY: number;
  splitOriginX: number;
  mergeOriginX: number;
}

export interface RouteGeometry {
  width: number;
  height: number;
  /** Trunk centre, in fan-local coordinates (y = 0 at `.split-routes`' top). */
  center: number;
  /** Lane centres, in fan-local coordinates. */
  laneCenters: number[];
  /** `top` for each `.lane-row::before`, relative to its own row. */
  laneLineTops: number[];
  /** x of the split fan's vertical riser, and of the merge fan's. */
  junction: number;
  mergeJunction: number;
}

export function snapRouteGeometry(raw: RawRouteGeometry, grid: RouteGrid): RouteGeometry {
  const { scale, thickness } = grid;
  const flowCenter = snapCenter(raw.flowHeight / 2, scale, thickness, raw.originY);
  const flowLaneCenters = raw.laneCenters.map((center) =>
    snapCenter(center, scale, thickness, raw.originY),
  );
  return {
    // Left unsnapped on purpose: the arms butt into the lane line at exactly
    // the column edge, and moving that endpoint would either gap or overlap it.
    width: raw.width,
    height: raw.height,
    center: flowCenter - raw.top,
    laneCenters: flowLaneCenters.map((center) => center - raw.top),
    laneLineTops: flowLaneCenters.map(
      (center, i) => center - (raw.laneTops[i] ?? 0) - thickness / 2,
    ),
    junction: snapCenter(raw.width * SPLIT_JUNCTION_RATIO, scale, thickness, raw.splitOriginX),
    mergeJunction: snapCenter(raw.width * MERGE_JUNCTION_RATIO, scale, thickness, raw.mergeOriginX),
  };
}

/** `top` for `.rack-flow::before`. The trunk spans the whole chain, so its own
    box is the one shared origin the fans are snapped against. Undefined until
    the chain has been measured, leaving the CSS fallback in charge. */
export function trunkTop(flow: FlowMetrics, grid: RouteGrid): string | undefined {
  if (!(flow.height > 0)) return undefined;
  return `${snapCenter(flow.height / 2, grid.scale, grid.thickness, flow.originY) - grid.thickness / 2}px`;
}

/** `top` for one `.lane-row::before`, relative to its own row. Undefined for a
    lane added since the last measurement, which the CSS fallback centres until
    the observer catches up. */
export function laneLineTop(
  geometry: RouteGeometry | undefined,
  index: number,
): string | undefined {
  const top = geometry?.laneLineTops[index];
  return top === undefined ? undefined : `${top}px`;
}

/** Orthogonal split path with quadratic corner radii at both turns. */
export function splitPath(geometry: RouteGeometry, laneCenter: number, grid: RouteGrid): string {
  return fanPath(geometry.center, laneCenter, geometry.junction, geometry.width, grid);
}

/** Mirror of splitPath: rounded lane routes converge onto one output. */
export function mergePath(geometry: RouteGeometry, laneCenter: number, grid: RouteGrid): string {
  return fanPath(laneCenter, geometry.center, geometry.mergeJunction, geometry.width, grid);
}

function fanPath(
  fromY: number,
  toY: number,
  junction: number,
  width: number,
  grid: RouteGrid,
): string {
  const delta = toY - fromY;
  // Under one device pixel of offset there is no turn to draw, and forcing one
  // would only smear the straight run it replaces.
  if (Math.abs(delta) * grid.scale < 0.5) return `M 0 ${fromY} H ${width}`;
  const direction = Math.sign(delta);
  const radius = elbowRadius(delta, junction, width, grid);
  if (radius === 0) return `M 0 ${fromY} H ${junction} V ${toY} H ${width}`;
  return `M 0 ${fromY} H ${junction - radius} Q ${junction} ${fromY} ${junction} ${fromY + direction * radius} V ${toY - direction * radius} Q ${junction} ${toY} ${junction + radius} ${toY} H ${width}`;
}

function elbowRadius(delta: number, junction: number, width: number, grid: RouteGrid): number {
  // The turn also has to fit *horizontally*, between the column's edge and the
  // junction on one side and the junction and the far edge on the other. Past
  // that the lead-in runs backwards — `H -2` before a curve that returns right —
  // and the stroke doubles over itself just outside the column, which is what a
  // radius large enough to want more than the column has looks like on screen.
  // Floored onto the pixel grid, so the snap below cannot round back past it.
  const room = Math.floor(Math.min(junction, width - junction) * grid.scale) / grid.scale;
  const ideal = snapEdge(Math.min(MAX_ELBOW_RADIUS, width * ELBOW_RADIUS_RATIO, room), grid.scale);
  // Both elbows share the vertical run, so neither may take more than half.
  // Floor rather than round: half of an odd device-pixel gap rounds up, and the
  // two curves would cross.
  const limit = Math.floor((Math.abs(delta) * grid.scale) / 2) / grid.scale;
  return Math.max(0, Math.min(ideal, limit));
}

/** The add-lane stem continues the split trunk down to the prospective next
    lane. Its lower end and its bottom border are pinned by CSS; only the run
    back up to the last lane varies, and that lane can be far above the box
    bottom when it holds a tall plugin card. The height is left unsnapped
    because it moves an open end: reaching the far side of the lane line rather
    than its near side is what keeps the join seam-free, and rounding that to
    the grid would only pull it back off the line. */
export function actionStemHeight(
  geometry: RouteGeometry | undefined,
  grid: RouteGrid,
): string | undefined {
  const lastLaneCenter = geometry?.laneCenters.at(-1);
  if (geometry === undefined || lastLaneCenter === undefined) return undefined;
  const overlapTop = lastLaneCenter - grid.thickness / 2;
  return `${geometry.height + STEM_ELBOW_BELOW_ROUTES_PX - overlapTop}px`;
}

/** The stem's box ends at the `2rem` column, so its width is the gap back to
    the fan's riser plus half a stroke — which puts its left border exactly on
    the riser instead of the ~1px to the side a fixed width leaves it. */
export function actionStemWidth(
  geometry: RouteGeometry | undefined,
  grid: RouteGrid,
): string | undefined {
  if (geometry === undefined) return undefined;
  return `${FAN_COLUMN_PX - geometry.junction + grid.thickness / 2}px`;
}
