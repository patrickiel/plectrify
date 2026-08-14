/**
 * The docs table of contents, in reading order.
 *
 * Hand-maintained rather than globbed from the filesystem: order and grouping
 * are editorial decisions that a directory listing cannot express, and there
 * are few enough pages that a missing entry is obvious. The build catches a
 * stale `href` regardless — prerendering fails on a broken internal link.
 */
export interface DocLink {
  href: string;
  label: string;
  /** One line, shown on the docs index. */
  blurb: string;
}

export interface DocSection {
  heading: string;
  links: DocLink[];
}

export const DOC_NAV: DocSection[] = [
  {
    heading: 'Start here',
    links: [
      {
        href: '/docs/getting-started',
        label: 'Getting started',
        blurb: 'Install, pick an audio device, scan your plugins, make a sound.',
      },
      {
        href: '/docs/opening-on-macos',
        label: 'Opening it on macOS',
        blurb: 'Gatekeeper calls the build damaged. It is not — here is the way past it.',
      },
      {
        href: '/docs/audio-setup',
        label: 'Audio setup and latency',
        blurb: 'Device types, buffer sizes, and what to do when it crackles.',
      },
    ],
  },
  {
    heading: 'Building',
    links: [
      {
        href: '/docs/rigs',
        label: 'Modules, chains and rigs',
        blurb: 'Add, reorder and bypass modules; split into parallel lanes; save the lot.',
      },
      {
        href: '/docs/patches',
        label: 'Knobs and patches',
        blurb: 'Map the parameters you play with and save them as a reusable patch.',
      },
      {
        href: '/docs/packages',
        label: 'Plugin packages',
        blurb: 'Install curated amps, cabs and effects from inside the app.',
      },
      {
        href: '/docs/tone3000',
        label: 'Tones from TONE3000',
        blurb: 'Browse the community capture library and load a tone as a patch.',
      },
    ],
  },
  {
    heading: 'Reference',
    links: [
      {
        href: '/docs/troubleshooting',
        label: 'Troubleshooting',
        blurb: 'No sound, a plugin that will not scan, and other common walls.',
      },
    ],
  },
];

export const ALL_DOCS: DocLink[] = DOC_NAV.flatMap((section) => section.links);
