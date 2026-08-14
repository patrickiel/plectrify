import { describe, expect, it } from 'vitest';
import { shortcutIndex } from '../../lib/keyboardShortcuts';
import { RIG_SHORTCUT_KEYS, SCENE_SHORTCUT_KEYS } from './shortcutKeys';

describe('rig shortcut keys', () => {
  it('covers the alphabet in order', () => {
    expect(RIG_SHORTCUT_KEYS).toHaveLength(26);
    expect(RIG_SHORTCUT_KEYS[0]).toBe('A');
    expect(RIG_SHORTCUT_KEYS[25]).toBe('Z');
    expect(RIG_SHORTCUT_KEYS[26]).toBeUndefined();
  });

  it('matches letters case-insensitively', () => {
    expect(shortcutIndex('a', RIG_SHORTCUT_KEYS)).toBe(0);
    expect(shortcutIndex('Z', RIG_SHORTCUT_KEYS)).toBe(25);
  });
});

describe('scene shortcut keys', () => {
  it('maps one through nine before zero', () => {
    expect(SCENE_SHORTCUT_KEYS).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(SCENE_SHORTCUT_KEYS.at(10)).toBeUndefined();
  });

  it('rejects unrelated keys', () => {
    expect(shortcutIndex('0', SCENE_SHORTCUT_KEYS)).toBe(9);
    expect(shortcutIndex('!', SCENE_SHORTCUT_KEYS)).toBe(-1);
    expect(shortcutIndex('Enter', SCENE_SHORTCUT_KEYS)).toBe(-1);
  });
});
