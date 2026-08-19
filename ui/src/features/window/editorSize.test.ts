import { describe, expect, it } from 'vitest';
import { MIN_EDITOR_SIZE, grippedSize } from './editorSize';

const corner = {
  edge: 'bottom-right',
  pointerX: 1000,
  pointerY: 600,
  width: 1040,
  height: 640,
} as const;

describe('grippedSize', () => {
  it('returns the pressed size while the pointer has not moved', () => {
    expect(grippedSize(corner, { x: 1000, y: 600 })).toEqual({ width: 1040, height: 640 });
  });

  it('grows and shrinks by the drag delta, per axis', () => {
    expect(grippedSize(corner, { x: 1200, y: 550 })).toEqual({ width: 1240, height: 590 });
  });

  it('never goes below the editor floor, however far the drag overshoots', () => {
    expect(grippedSize(corner, { x: -5000, y: -5000 })).toEqual(MIN_EDITOR_SIZE);
  });

  it('rounds fractional pointer positions to whole pixels', () => {
    const sized = grippedSize(corner, { x: 1000.4, y: 600.6 });
    expect(sized).toEqual({ width: 1040, height: 641 });
  });

  it('holds the height while the right edge is dragged', () => {
    const sized = grippedSize({ ...corner, edge: 'right' }, { x: 1200, y: 400 });
    expect(sized).toEqual({ width: 1240, height: 640 });
  });

  it('holds the width while the bottom edge is dragged', () => {
    const sized = grippedSize({ ...corner, edge: 'bottom' }, { x: 400, y: 700 });
    expect(sized).toEqual({ width: 1040, height: 740 });
  });

  it('still floors the axis a one-sided drag holds', () => {
    const small = { ...corner, edge: 'right', width: 100, height: 100 } as const;
    expect(grippedSize(small, { x: 1000, y: 600 })).toEqual(MIN_EDITOR_SIZE);
  });
});
