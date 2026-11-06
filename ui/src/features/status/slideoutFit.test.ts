import { describe, expect, it } from 'vitest';
import { slideoutShift } from './slideoutFit';

const WINDOW = { left: 0, right: 1000 };

describe('slideoutShift', () => {
  it('leaves a panel alone when it fits', () => {
    expect(slideoutShift({ left: 300, right: 700 }, WINDOW, 8)).toBe(0);
  });

  it('leaves a panel alone when it sits exactly on the margin', () => {
    expect(slideoutShift({ left: 8, right: 408 }, WINDOW, 8)).toBe(0);
    expect(slideoutShift({ left: 592, right: 992 }, WINDOW, 8)).toBe(0);
  });

  it('moves a panel right, just far enough, off the left edge', () => {
    expect(slideoutShift({ left: -50, right: 350 }, WINDOW, 8)).toBe(58);
  });

  it('moves a panel left, just far enough, off the right edge', () => {
    expect(slideoutShift({ left: 700, right: 1100 }, WINDOW, 8)).toBe(-108);
  });

  it('keeps the left edge of a panel too wide to fit either way', () => {
    expect(slideoutShift({ left: -100, right: 1100 }, WINDOW, 8)).toBe(108);
  });

  it('measures against bounds that do not start at zero', () => {
    expect(slideoutShift({ left: 90, right: 300 }, { left: 100, right: 500 }, 8)).toBe(18);
  });
});
