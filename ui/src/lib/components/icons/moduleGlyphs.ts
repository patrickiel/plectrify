import type { ModuleIcon } from '../../engine/moduleAppearance';

/** The artwork for each module icon: a 24×24 stroke path (multiple subpaths
    allowed in the one `d`) drawn by `ModuleGlyph.svelte`. Hand-drawn rather
    than taken from an icon set: these name signal-chain roles (amp, cab,
    fuzz…) that general-purpose sets have no honest glyphs for. Kept as data —
    the style picker iterates this map, and a new icon is a path here plus its
    id in `MODULE_ICONS`. Zero-length `H x.01` segments render as dots via the
    round line cap. */
export const MODULE_GLYPHS: Record<ModuleIcon, { label: string; d: string }> = {
  amp: {
    label: 'Amp',
    d: 'M3 6H21V18H3ZM3 10H21M8 8H8.01M12 8H12.01M16 8H16.01M7 14H17M7 16H17',
  },
  cab: {
    label: 'Cabinet',
    d: 'M4 4H20V20H4ZM17 12A5 5 0 1 1 7 12A5 5 0 1 1 17 12M12 12H12.01',
  },
  drive: {
    label: 'Drive',
    d: 'M13 2L3 14H12L11 22L21 10H12L13 2Z',
  },
  fuzz: {
    label: 'Fuzz',
    d: 'M3 14L6 10L8 16L10 8L12 16L14 8L16 15L18 10L21 13',
  },
  delay: {
    label: 'Delay',
    d: 'M4 4V20M10 7V17M15 10V14M19 11.5V12.5',
  },
  reverb: {
    label: 'Reverb',
    d: 'M5 12H5.01M9 8A5.7 5.7 0 0 1 9 16M13 5A10 10 0 0 1 13 19',
  },
  mod: {
    label: 'Modulation',
    d: 'M2 12C3.7 7 5.3 7 7 12S10.3 17 12 12S15.3 7 17 12S20.3 17 22 12',
  },
  comp: {
    label: 'Compressor',
    d: 'M3 12H9M6.5 9.5L9 12L6.5 14.5M21 12H15M17.5 9.5L15 12L17.5 14.5M12 5V19',
  },
  eq: {
    label: 'EQ',
    d: 'M5 4V20M12 4V20M19 4V20M3 9H7M10 15H14M17 7H21',
  },
  pitch: {
    label: 'Pitch',
    d: 'M7 18A2 2 0 1 0 11 18A2 2 0 1 0 7 18M17 16A2 2 0 1 0 21 16A2 2 0 1 0 17 16M11 18V6L21 4V16',
  },
  filter: {
    label: 'Filter',
    d: 'M3 4H21L14 12.5V20L10 18V12.5L3 4Z',
  },
  util: {
    label: 'Utility',
    d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  },
};
