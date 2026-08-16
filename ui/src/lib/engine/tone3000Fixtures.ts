import type { Tone3000Model, Tone3000Tone } from './tone3000';

/**
 * Stand-in tones for MockEngine, so the whole TONE3000 panel — splash, tabs,
 * detail view, model selector, install progress, missing-capture repair — can
 * be driven in the browser with `pnpm dev`, offline and with no account.
 *
 * Artwork is inline SVG rather than a remote URL on purpose: the mock has to
 * work with no network at all, and a broken image in the one place the design
 * is being judged is worse than no image.
 */

/** A flat, tinted card standing in for a tone's photograph. */
function artwork(hue: number, initials: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 45% 32%)"/>
    <stop offset="1" stop-color="hsl(${hue + 25} 40% 16%)"/>
  </linearGradient></defs>
  <rect width="320" height="200" fill="url(#g)"/>
  <text x="160" y="118" font-family="system-ui, sans-serif" font-size="58" font-weight="700"
        fill="hsl(${hue} 60% 82%)" fill-opacity=".55" text-anchor="middle">${initials}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const creators = [
  {
    id: '1',
    username: 'valveworks',
    avatarUrl: artwork(20, 'V'),
    url: 'https://example.invalid/v',
  },
  {
    id: '2',
    username: 'cabinetlab',
    avatarUrl: artwork(200, 'C'),
    url: 'https://example.invalid/c',
  },
  {
    id: '3',
    username: 'dirtboxes',
    avatarUrl: artwork(320, 'D'),
    url: 'https://example.invalid/d',
  },
];

function tone(
  id: number,
  title: string,
  gear: string,
  format: string,
  hue: number,
  creator: number,
  description?: string,
): Tone3000Tone {
  return {
    id,
    title,
    gear,
    format,
    description,
    license: format === 'ir' ? 'cc-by' : 't3k',
    url: `https://www.tone3000.com/tones/${id}`,
    imageUrl: artwork(hue, title.slice(0, 2).toUpperCase()),
    creator: creators[creator],
    modelsCount: 3,
    downloadsCount: 400 + id * 7,
    favoritesCount: 30 + id,
  };
}

export const MOCK_TONES: Tone3000Tone[] = [
  tone(
    101,
    'JTM45 Crunch',
    'amp-cab',
    'nam',
    20,
    0,
    'A 1963 head into a 4x12, mic on the cap edge.',
  ),
  tone(102, 'Tweed Deluxe', 'amp', 'nam', 40, 0, 'Cranked, warm, and happy to fall apart.'),
  tone(103, 'Modern High Gain', 'amp-cab', 'nam', 280, 2),
  tone(104, 'Greenback 4x12', 'cab', 'ir', 200, 1, 'Four positions, 48 kHz, 200 ms.'),
  tone(105, 'Vintage 30 Pair', 'cab', 'ir', 180, 1),
  tone(106, 'Klon-ish Drive', 'pedal', 'nam', 50, 2),
  tone(107, 'Fuzz Face Silicon', 'pedal', 'nam', 340, 2),
  tone(108, 'AC30 Top Boost', 'amp-cab', 'nam', 100, 0),
  tone(109, 'Plate Chamber', 'space', 'ir', 220, 1),
  tone(110, 'Bass DI Rig', 'amp-cab', 'nam', 260, 0),
];

/** Three models per tone, in the sizes TONE3000 publishes — enough for the
    detail view's model selector to be a real choice rather than a single row. */
export function mockModelsFor(toneId: number): Tone3000Model[] {
  const parent = MOCK_TONES.find((t) => t.id === toneId);
  const isIr = parent?.format === 'ir';
  return [
    {
      id: toneId * 10 + 1,
      toneId,
      name: isIr ? 'Cap edge' : 'Standard',
      size: 'standard',
      architecture: '2',
      url: `https://example.invalid/${toneId}-1.${isIr ? 'wav' : 'nam'}`,
    },
    {
      id: toneId * 10 + 2,
      toneId,
      name: isIr ? 'Cone' : 'Lite',
      size: 'lite',
      architecture: '2',
      url: `https://example.invalid/${toneId}-2.${isIr ? 'wav' : 'nam'}`,
    },
    {
      id: toneId * 10 + 3,
      toneId,
      name: isIr ? 'Blend' : 'Feather',
      size: 'feather',
      architecture: '1',
      url: `https://example.invalid/${toneId}-3.${isIr ? 'wav' : 'nam'}`,
    },
  ];
}
