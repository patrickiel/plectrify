import { describe, expect, it } from 'vitest';
import { mojibakeReviver, repairMojibake } from './mojibake';

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
    ]) {
      expect(repairMojibake(text)).toBe(text);
    }
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
});
