import { describe, expect, it } from 'vitest';
import { mojibakeReviver, repairJsonDocument, repairMojibake } from './mojibake';

/** What one crossing of the unpatched Linux pipe did to a string. */
function damage(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join('');
}

function damageTimes(text: string, times: number): string {
  let current = text;
  for (let i = 0; i < times; i++) current = damage(current);
  return current;
}

describe('repairMojibake', () => {
  it('repairs the tone name from issue #48 at every depth', () => {
    const name = 'EVH 5150III® 100S stealth green low gain';
    for (let layers = 1; layers <= 8; layers++) {
      expect(repairMojibake(damageTimes(name, layers))).toBe(name);
    }
  });

  it('reads the bytes the issue found on disk', () => {
    expect(repairMojibake('EVH 5150IIIÃ\u0083Â\u0082Ã\u0082Â® 100S')).toBe('EVH 5150III® 100S');
  });

  it('repairs characters outside Latin-1', () => {
    for (const text of ['Überdrive — 🎸', 'Ακουστική', 'ギター']) {
      expect(repairMojibake(damageTimes(text, 3))).toBe(text);
    }
  });

  it('leaves undamaged text alone', () => {
    for (const text of [
      '',
      'Plain ASCII',
      'EVH 5150III® 100S',
      'Café crème',
      'Überdrive',
      '½ gain ±3 dB · 90°',
      'Ακουστική',
      '🎸',
      // Nothing but an unfinished sequence: how these words are spelled.
      'IRMÃ',
      'Città',
      'Café olé',
      // A sequence by its bytes, in a string that is not one throughout.
      '« ARRIVÉ\u00a0»',
    ]) {
      expect(repairMojibake(text)).toBe(text);
    }
  });

  it('repairs a note the page clamped mid-sequence', () => {
    // songs.ts cuts notes to 240 characters on every load, which lands inside
    // the expansion of the "é" once enough layers have piled up.
    const clamped = damageTimes('Señor Café solo, capo 2', 7).slice(0, 240);
    const repaired = repairMojibake(clamped);
    expect(repaired.startsWith('Señor Caf')).toBe(true);
    expect(repaired.length).toBeLessThanOrEqual('Señor Café'.length);
    expect(repaired).not.toMatch(/[\u0080-\u009f]/);
  });

  it('leaves at most one stray character wherever a clamp falls', () => {
    const name = 'Niño ®';
    const damaged = damageTimes(name, 4);
    for (let length = 1; length < damaged.length; length++) {
      const repaired = repairMojibake(damaged.slice(0, length));
      expect(repaired).not.toMatch(/[\u0080-\u009f]/);
      expect(name.startsWith(repaired.slice(0, -1))).toBe(true);
    }
  });

  it('gives back the "à" a trim took the last byte of', () => {
    // U+00A0 is whitespace to trim() and the second byte of "à".
    for (const name of ['Città', 'Più città', 'déjà']) {
      for (let layers = 2; layers <= 6; layers++) {
        expect(repairMojibake(damageTimes(name, layers).trim())).toBe(name);
      }
    }
    expect(repairMojibake(damage('Più città').trim())).toBe('Più città');
    expect(repairMojibake(damageTimes(damageTimes('Città', 2).trim(), 3))).toBe('Città');
  });
});

describe('mojibakeReviver', () => {
  it('repairs every string in a parsed document and nothing else', () => {
    const doc = {
      name: damageTimes('5150III®', 3),
      tone3000: { title: damage('Señor'), toneId: 7 },
      knobs: [{ label: damage('Gain °') }],
      bypassed: false,
    };
    expect(JSON.parse(JSON.stringify(doc), mojibakeReviver)).toEqual({
      name: '5150III®',
      tone3000: { title: 'Señor', toneId: 7 },
      knobs: [{ label: 'Gain °' }],
      bypassed: false,
    });
  });

  it('repairs object keys, which the drawer order takes from patch categories', () => {
    const stored = {
      drawerPatchOrder: { [`patches:${damageTimes('Verstärker', 2)}`]: ['a', 'b'] },
    };
    expect(JSON.parse(JSON.stringify(stored), mojibakeReviver)).toEqual({
      drawerPatchOrder: { 'patches:Verstärker': ['a', 'b'] },
    });
  });

  it('folds a damaged twin into the key it repairs to', () => {
    const twins = { [damage('Verstärker')]: 'old', Verstärker: 'new', __proto__x: 1 };
    expect(JSON.parse(JSON.stringify(twins), mojibakeReviver)).toEqual({
      Verstärker: 'new',
      __proto__x: 1,
    });
  });
});

describe('repairJsonDocument', () => {
  it('rewrites a document that carries damage', () => {
    const text = JSON.stringify({ name: damageTimes('5150III®', 3), state: 'QUJD' });
    expect(JSON.parse(repairJsonDocument(text)!)).toEqual({ name: '5150III®', state: 'QUJD' });
  });

  it('answers null for a document with nothing to repair', () => {
    for (const doc of [
      { name: 'Plain', state: 'QUJD' },
      { name: 'Café crème ®' },
      { name: 'ギター' },
    ]) {
      expect(repairJsonDocument(JSON.stringify(doc))).toBeNull();
    }
  });

  it('answers null for text that is not JSON', () => {
    expect(repairJsonDocument('RIFFÃ©')).toBeNull();
  });
});
