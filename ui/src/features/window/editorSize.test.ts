import { describe, expect, it } from 'vitest';
import { MIN_EDITOR_SIZE, grippedSize } from './editorSize';

const start = { pointerX: 1000, pointerY: 600, width: 1040, height: 640 };

describe('grippedSize', () => {
  it('returns the pressed size while the pointer has not moved', () => {
    expect(grippedSize(start, { x: 1000, y: 600 })).toEqual({ width: 1040, height: 640 });
  });

  it('grows and shrinks by the drag delta, per axis', () => {
    expect(grippedSize(start, { x: 1200, y: 550 })).toEqual({ width: 1240, height: 590 });
  });

  it('never goes below the editor floor, however far the drag overshoots', () => {
    expect(grippedSize(start, { x: -5000, y: -5000 })).toEqual(MIN_EDITOR_SIZE);
  });

  it('rounds fractional pointer positions to whole pixels', () => {
    const sized = grippedSize(start, { x: 1000.4, y: 600.6 });
    expect(sized).toEqual({ width: 1040, height: 641 });
  });
});
