import { describe, expect, it } from 'vitest';
import { deviceScale, snapThickness } from '../../lib/pixelSnap';
import {
  ROUTE_THICKNESS,
  actionStemHeight,
  actionStemWidth,
  laneLineTop,
  mergePath,
  snapRouteGeometry,
  splitPath,
  trunkTop,
  type RawRouteGeometry,
  type RouteGrid,
} from './routeGeometry';

const SCALES = [0.1, 0.5, 1, 1.25, 1.5, 2, 4.5];
const isWhole = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;

function gridFor(scale: number): RouteGrid {
  return { scale, thickness: snapThickness(ROUTE_THICKNESS, scale) };
}

/** Deliberately fractional throughout: a real rack measures content-sized plugin
    cards, so odd heights and half-pixel centres are the common case. The origins
    are fractional too — auto-margin centring routinely leaves the whole rack on
    a part-pixel, which is the offset an SVG stroke inherits and feathers on. */
function rawGeometry(overrides: Partial<RawRouteGeometry> = {}): RawRouteGeometry {
  return {
    width: 32,
    height: 246.5,
    top: 37.25,
    flowHeight: 321,
    laneTops: [37.25, 175.75],
    laneCenters: [98.4, 236.85],
    originY: 512.0625,
    splitOriginX: 640.46875,
    mergeOriginX: 913.3125,
    ...overrides,
  };
}

/** Every coordinate the fans emit, split into the ones that must carry the
    band's parity and the ones that are just endpoints. */
function pathCoords(d: string) {
  const tokens = d.trim().split(/\s+/);
  const xs: number[] = [];
  const ys: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') {
      xs.push(Number(tokens[i++]));
      ys.push(Number(tokens[i++]));
    } else if (command === 'H') xs.push(Number(tokens[i++]));
    else if (command === 'V') ys.push(Number(tokens[i++]));
    else if (command === 'Q') {
      xs.push(Number(tokens[i++]));
      ys.push(Number(tokens[i++]));
      xs.push(Number(tokens[i++]));
      ys.push(Number(tokens[i++]));
    } else throw new Error(`unexpected path command "${command}" in ${d}`);
  }
  expect(xs.every(Number.isFinite) && ys.every(Number.isFinite)).toBe(true);
  return { xs, ys };
}

describe('snapRouteGeometry', () => {
  it('keeps every lane, in order', () => {
    const raw = rawGeometry();
    const geometry = snapRouteGeometry(raw, gridFor(1.25));
    expect(geometry.laneCenters).toHaveLength(raw.laneCenters.length);
    expect(geometry.laneLineTops).toHaveLength(raw.laneCenters.length);
    expect(geometry.laneCenters[0]).toBeLessThan(geometry.laneCenters[1]);
    expect(geometry.width).toBe(raw.width);
    expect(geometry.height).toBe(raw.height);
  });

  // Device pixels of the *screen*, not of the box: a coordinate snapped only
  // against its own container still feathers by however far that container sits
  // off the grid.
  it('puts both edges of every lane line on whole device pixels', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const raw = rawGeometry();
      const geometry = snapRouteGeometry(raw, grid);
      for (const center of geometry.laneCenters) {
        const device = raw.originY + (center + raw.top) * scale;
        expect(isWhole(device - (grid.thickness * scale) / 2)).toBe(true);
        expect(isWhole(device + (grid.thickness * scale) / 2)).toBe(true);
      }
    }
  });

  // The join that used to drift: the SVG arm and the CSS lane line it meets are
  // positioned by different elements and must resolve to the same centre.
  it('lines each lane line up with the arm that feeds it', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const raw = rawGeometry();
      const geometry = snapRouteGeometry(raw, grid);
      geometry.laneLineTops.forEach((top, i) => {
        expect(top + raw.laneTops[i] + grid.thickness / 2).toBeCloseTo(
          geometry.laneCenters[i] + raw.top,
          9,
        );
      });
    }
  });

  // The trunk is masked across the split block and resumes on the far side, so
  // a fan centred anywhere else shows a step at both ends of every group.
  it('centres the fans on the serial trunk', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const raw = rawGeometry();
      const geometry = snapRouteGeometry(raw, grid);
      const top = Number.parseFloat(
        trunkTop({ height: raw.flowHeight, originY: raw.originY }, grid)!,
      );
      expect(geometry.center + raw.top).toBeCloseTo(top + grid.thickness / 2, 9);
    }
  });

  it('keeps the two fans mirror-symmetric after snapping', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const geometry = snapRouteGeometry(rawGeometry(), grid);
      expect(
        Math.abs(geometry.width - geometry.junction - geometry.mergeJunction),
      ).toBeLessThanOrEqual(1 / scale + 1e-9);
    }
  });

  // The riser used to land at 0.38 x 32 = 12.16 — soft at every scale, which is
  // why it read as a different weight from the horizontal arms beside it.
  it('puts the riser on the grid at 1:1', () => {
    const raw = rawGeometry({ splitOriginX: 0, mergeOriginX: 0 });
    const geometry = snapRouteGeometry(raw, gridFor(1));
    expect(geometry.junction).toBe(12);
    expect(geometry.mergeJunction).toBe(20);
  });

  it('offsets each riser by whatever its own fan sits off the grid', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const raw = rawGeometry();
      const geometry = snapRouteGeometry(raw, grid);
      const half = (grid.thickness * scale) / 2;
      expect(isWhole(raw.splitOriginX + geometry.junction * scale - half)).toBe(true);
      expect(isWhole(raw.mergeOriginX + geometry.mergeJunction * scale - half)).toBe(true);
    }
  });
});

describe('splitPath / mergePath', () => {
  it('emits only grid-aligned coordinates', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      // Lanes above, below, and level with the trunk.
      const raw = rawGeometry({
        laneCenters: [98.4, 160.5, 236.85],
        laneTops: [37.25, 130.1, 175.75],
      });
      const geometry = snapRouteGeometry(raw, grid);
      const half = (grid.thickness * scale) / 2;
      for (const laneCenter of geometry.laneCenters) {
        const fans = [
          {
            d: splitPath(geometry, laneCenter, grid),
            originX: raw.splitOriginX,
            riser: geometry.junction,
          },
          {
            d: mergePath(geometry, laneCenter, grid),
            originX: raw.mergeOriginX,
            riser: geometry.mergeJunction,
          },
        ];
        for (const { d, originX, riser } of fans) {
          const { xs, ys } = pathCoords(d);
          // Every y is the centre of a horizontal run, in fan-local coordinates
          // that the fan's own offset within `.rack-flow` turns into a screen
          // position.
          for (const y of ys) {
            expect(isWhole(raw.originY + (y + raw.top) * scale - half)).toBe(true);
          }
          // The x endpoints sit at 0 and `width` by design — they butt into the
          // lines either side. Every other x belongs to the riser, and must land
          // on the grid its own fan sits on.
          for (const x of xs.filter((value) => value !== 0 && value !== geometry.width)) {
            expect(isWhole(originX + x * scale - half)).toBe(true);
            expect(isWhole((x - riser) * scale)).toBe(true);
          }
        }
      }
    }
  });

  it('draws a straight run for a lane already on the trunk', () => {
    const grid = gridFor(1);
    const raw = rawGeometry({ laneCenters: [160.5], laneTops: [130.1] });
    const geometry = snapRouteGeometry(raw, grid);
    const straight = `M 0 ${geometry.center} H ${geometry.width}`;
    expect(splitPath(geometry, geometry.center, grid)).toBe(straight);
    expect(mergePath(geometry, geometry.center, grid)).toBe(straight);
  });

  it('never lets the two elbows overlap', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const geometry = snapRouteGeometry(rawGeometry(), grid);
      // Walk the offset down to a single device pixel: the elbows have to give
      // way and eventually degenerate into a sharp corner rather than cross.
      for (let steps = 1; steps <= 12; steps += 1) {
        const laneCenter = geometry.center + steps / scale;
        const d = splitPath(geometry, laneCenter, grid);
        const { ys } = pathCoords(d);
        for (const y of ys) {
          expect(y).toBeGreaterThanOrEqual(geometry.center - 1e-9);
          expect(y).toBeLessThanOrEqual(laneCenter + 1e-9);
        }
        if (steps === 1)
          expect(d).toBe(
            `M 0 ${geometry.center} H ${geometry.junction} V ${laneCenter} H ${geometry.width}`,
          );
      }
    }
  });
});

describe('add-lane stem', () => {
  it('sits collinear with the split fan riser', () => {
    for (const scale of SCALES) {
      const grid = gridFor(scale);
      const geometry = snapRouteGeometry(rawGeometry(), grid);
      const width = Number.parseFloat(actionStemWidth(geometry, grid)!);
      // 32 is the `2rem` column the stem's box ends at; its left border centre
      // has to land on the riser.
      expect(32 - width + grid.thickness / 2).toBeCloseTo(geometry.junction, 9);
    }
  });

  it('overlaps the last lane line instead of butting against it', () => {
    const grid = gridFor(1);
    const geometry = snapRouteGeometry(rawGeometry(), grid);
    const height = Number.parseFloat(actionStemHeight(geometry, grid)!);
    const stemTop = geometry.height + 28 - height;
    expect(stemTop).toBeCloseTo(geometry.laneCenters.at(-1)! - grid.thickness / 2, 9);
  });

  it('has nothing to draw before the first measurement lands', () => {
    const grid = gridFor(1);
    expect(actionStemHeight(undefined, grid)).toBeUndefined();
    expect(actionStemWidth(undefined, grid)).toBeUndefined();
    const empty = snapRouteGeometry(rawGeometry({ laneTops: [], laneCenters: [] }), grid);
    expect(actionStemHeight(empty, grid)).toBeUndefined();
  });
});

// Everything a route can be asked for before its box has been measured has to
// come back undefined, so the CSS fallback centres it for that one frame rather
// than the template emitting "undefinedpx" and dropping the line entirely.
describe('pre-measurement fallbacks', () => {
  const grid = gridFor(1);

  it('leaves the trunk to CSS until the chain has a height', () => {
    expect(trunkTop({ height: 0, originY: 0 }, grid)).toBeUndefined();
    expect(trunkTop({ height: NaN, originY: 0 }, grid)).toBeUndefined();
    expect(trunkTop({ height: 321, originY: 0 }, grid)).toBe('160px');
  });

  it('leaves a lane added since the last measurement to CSS', () => {
    const geometry = snapRouteGeometry(rawGeometry(), grid);
    expect(laneLineTop(undefined, 0)).toBeUndefined();
    expect(laneLineTop(geometry, geometry.laneLineTops.length)).toBeUndefined();
    expect(laneLineTop(geometry, 0)).toBe(`${geometry.laneLineTops[0]}px`);
  });
});
