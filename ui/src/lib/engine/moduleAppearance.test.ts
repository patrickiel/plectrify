import { describe, expect, it } from 'vitest';
import {
  MODULE_ICONS,
  MODULE_STYLE_VARIANTS,
  MODULE_TEXTURES,
  asModuleColor,
  asModuleIcon,
  asModuleTexture,
  asStyleVariant,
} from './moduleAppearance';

describe('the appearance guards', () => {
  it('admit every id they publish', () => {
    for (const v of MODULE_STYLE_VARIANTS) expect(asStyleVariant(v)).toBe(v);
    for (const t of MODULE_TEXTURES) expect(asModuleTexture(t)).toBe(t);
    for (const i of MODULE_ICONS) expect(asModuleIcon(i)).toBe(i);
  });

  it('degrade anything else to undefined — the default look, never a rejection', () => {
    for (const guard of [asStyleVariant, asModuleTexture, asModuleIcon]) {
      expect(guard('chrome')).toBeUndefined();
      expect(guard(42)).toBeUndefined();
      expect(guard(null)).toBeUndefined();
      expect(guard('')).toBeUndefined();
      expect(guard(undefined)).toBeUndefined();
    }
  });
});

describe('asModuleColor', () => {
  it('admits a full hex colour in either case', () => {
    expect(asModuleColor('#c04a2b')).toBe('#c04a2b');
    expect(asModuleColor('#A1B2C3')).toBe('#A1B2C3');
  });

  it('refuses anything else — the value lands in an inline style attribute', () => {
    expect(asModuleColor('red')).toBeUndefined();
    expect(asModuleColor('#fff')).toBeUndefined();
    expect(asModuleColor('#gggggg')).toBeUndefined();
    expect(asModuleColor('url(x)')).toBeUndefined();
    expect(asModuleColor('#c04a2b;background:url(x)')).toBeUndefined();
    expect(asModuleColor(0xc04a2b)).toBeUndefined();
    expect(asModuleColor(undefined)).toBeUndefined();
  });
});
