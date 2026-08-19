import { describe, expect, it } from 'vitest';
import {
  clampDrawerHeight,
  liveHeightFor,
  resizeKeyAction,
  resizeRelease,
} from './drawerResize.svelte';
import { MAX_DRAWER_HEIGHT, MIN_DRAWER_HEIGHT } from '../../lib/engine/appSettings';

/** A roomy workspace, so `maxHeight` is not the binding constraint. */
const ROOMY = 900;

describe('clampDrawerHeight', () => {
  it('holds the settings floor', () => {
    expect(clampDrawerHeight(10, ROOMY)).toBe(MIN_DRAWER_HEIGHT);
  });

  it('holds the settings ceiling', () => {
    expect(clampDrawerHeight(99_999, 99_999)).toBe(MAX_DRAWER_HEIGHT);
  });

  it('never grows past the workspace', () => {
    expect(clampDrawerHeight(99_999, ROOMY)).toBe(ROOMY);
  });

  // A workspace shorter than the floor still has to yield a usable height:
  // the inner Math.max is what stops the ceiling dropping below the floor.
  it('yields the floor when the workspace is shorter than it', () => {
    expect(clampDrawerHeight(400, 40)).toBe(MIN_DRAWER_HEIGHT);
    expect(clampDrawerHeight(10, 40)).toBe(MIN_DRAWER_HEIGHT);
  });

  it('rounds to whole pixels', () => {
    expect(clampDrawerHeight(300.4, ROOMY)).toBe(300);
    expect(clampDrawerHeight(300.6, ROOMY)).toBe(301);
  });
});

describe('liveHeightFor', () => {
  it('follows the pointer below the settings floor, down to the shelf', () => {
    // 80 is under MIN_DRAWER_HEIGHT and still honoured — pinning at the floor
    // while the pointer keeps going reads as the handle slipping.
    expect(liveHeightFor(80, 54, ROOMY)).toBe(80);
  });

  it('never goes below the shelf', () => {
    expect(liveHeightFor(-200, 54, ROOMY)).toBe(54);
  });

  it('never goes above the full height', () => {
    expect(liveHeightFor(5000, 54, ROOMY)).toBe(ROOMY);
  });

  it('rounds to whole pixels', () => {
    expect(liveHeightFor(300.6, 54, ROOMY)).toBe(301);
  });
});

describe('resizeRelease', () => {
  const ctx = (over: Partial<Parameters<typeof resizeRelease>[1]> = {}) => ({
    collapsed: false,
    fullHeight: 1000,
    liveHeight: 400 as number | null,
    height: 300,
    maxHeight: ROOMY,
    ...over,
  });

  it('reads a gesture that never moved as a click, whether open or collapsed', () => {
    expect(resizeRelease({ moved: false, raw: 400 }, ctx())).toEqual({ kind: 'toggle' });
    expect(resizeRelease({ moved: false, raw: 54 }, ctx({ collapsed: true }))).toEqual({
      kind: 'toggle',
    });
  });

  it('collapses when released in the bottom tenth', () => {
    expect(resizeRelease({ moved: true, raw: 99 }, ctx())).toEqual({ kind: 'collapse' });
  });

  it('maximizes when released in the top fifth', () => {
    expect(resizeRelease({ moved: true, raw: 801 }, ctx())).toEqual({ kind: 'maximize' });
  });

  // Strict comparisons: exactly on either line is an ordinary commit.
  it('treats the two boundaries as neither collapse nor maximize', () => {
    expect(resizeRelease({ moved: true, raw: 100 }, ctx()).kind).toBe('commit');
    expect(resizeRelease({ moved: true, raw: 800 }, ctx()).kind).toBe('commit');
  });

  it('commits the clamped live height in between', () => {
    expect(resizeRelease({ moved: true, raw: 400 }, ctx({ liveHeight: 400 }))).toEqual({
      kind: 'commit',
      height: 400,
    });
  });

  it('commits nothing when the clamped height has not changed', () => {
    // No redundant settings write for a drag that ended where it started.
    expect(resizeRelease({ moved: true, raw: 300 }, ctx({ liveHeight: 300, height: 300 }))).toEqual(
      {
        kind: 'none',
      },
    );
  });

  it('commits the floor when the drag ran below it', () => {
    expect(resizeRelease({ moved: true, raw: 120 }, ctx({ liveHeight: 120 }))).toEqual({
      kind: 'commit',
      height: MIN_DRAWER_HEIGHT,
    });
  });

  it('does nothing when no live height was ever taken', () => {
    expect(resizeRelease({ moved: true, raw: 400 }, ctx({ liveHeight: null }))).toEqual({
      kind: 'none',
    });
  });

  // `collapsed` lags within one gesture: the move handler asks for
  // onSetCollapsed(false) and the settings round-trip has not landed by the
  // time the pointer comes up. The guards are what stop that half-applied
  // state from being read as a collapse or a maximize.
  it('leaves a still-collapsed drawer alone, however far the drag went', () => {
    expect(resizeRelease({ moved: true, raw: 20 }, ctx({ collapsed: true }))).toEqual({
      kind: 'none',
    });
    expect(resizeRelease({ moved: true, raw: 950 }, ctx({ collapsed: true }))).toEqual({
      kind: 'none',
    });
  });
});

describe('resizeKeyAction', () => {
  const open = { collapsed: false, shownHeight: 400 };

  it('toggles on Enter and Space', () => {
    expect(resizeKeyAction('Enter', open)).toEqual({ kind: 'toggle' });
    expect(resizeKeyAction(' ', open)).toEqual({ kind: 'toggle' });
  });

  it('steps the height with the arrows', () => {
    expect(resizeKeyAction('ArrowUp', open)).toEqual({ kind: 'step', px: 24 });
    expect(resizeKeyAction('ArrowDown', open)).toEqual({ kind: 'step', px: -24 });
  });

  it('reopens a collapsed drawer with ArrowUp', () => {
    expect(resizeKeyAction('ArrowUp', { collapsed: true, shownHeight: 54 })).toEqual({
      kind: 'expand',
    });
  });

  // Still claimed, so the page does not scroll under it — but there is
  // nowhere further down to go.
  it('does nothing pressing ArrowDown on a collapsed drawer', () => {
    expect(resizeKeyAction('ArrowDown', { collapsed: true, shownHeight: 54 })).toEqual({
      kind: 'none',
    });
  });

  it('collapses stepping down from the floor', () => {
    expect(
      resizeKeyAction('ArrowDown', { collapsed: false, shownHeight: MIN_DRAWER_HEIGHT }),
    ).toEqual({ kind: 'collapse' });
  });

  it('lets every other key through untouched', () => {
    expect(resizeKeyAction('a', open)).toEqual({ kind: 'ignore' });
    expect(resizeKeyAction('Tab', open)).toEqual({ kind: 'ignore' });
    expect(resizeKeyAction('ArrowLeft', open)).toEqual({ kind: 'ignore' });
  });
});
