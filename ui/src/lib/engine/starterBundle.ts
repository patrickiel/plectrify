import type { AppSettings } from './types';
import type { CatalogueState } from './catalogue';

/** The bundle a fresh installation fetches by itself. One id, matching
    packaging/catalogue.json — the bundle's *contents* are the catalogue's
    business and can change without a release, which is the whole reason this
    names a bundle rather than a list of plugins. */
export const STARTER_BUNDLE_ID = 'starter';

/** What a launch owes the starter bundle, if anything.

    `markAttempted` is the "never again" half and is deliberately set for cases
    that install nothing: a machine that already has packages is not new, and
    saying so once is what stops every later launch asking the question again.
    It is *not* set when the catalogue could not be read — no run was started,
    so nothing was attempted, and the next launch (online, perhaps) still
    owes one. */
export interface StarterDecision {
  /** Package ids to install as the starter bundle, in catalogue order. */
  install: string[];
  /** Whether to record the attempt in AppSettings, settling the question. */
  markAttempted: boolean;
}

const NOTHING: StarterDecision = { install: [], markAttempted: false };

/** Should this launch install the starter bundle by itself?

    Pure, so the rule is one testable statement rather than a condition spread
    across the engine. The caller must have loaded the real settings first —
    the defaults say "not attempted", which is true only of a machine with no
    settings.json at all. */
export function decideStarterAutoInstall(
  catalogue: CatalogueState,
  settings: AppSettings,
): StarterDecision {
  if (settings.starterInstallAttempted) return NOTHING;

  // Nothing usable to install from, or a run already going: no attempt has
  // been made, so leave the question open for the next launch.
  if (catalogue.source === 'none' || catalogue.busy) return NOTHING;

  const bundle = catalogue.bundles.find((b) => b.id === STARTER_BUNDLE_ID);
  if (bundle === undefined) return NOTHING;

  // Any package installed — from the panel, from a bundle, or left behind by
  // an earlier version — means this is not a first run, whatever settings.json
  // says. Settle it without installing anything.
  const untouched = bundle.installedVersion === '' && !catalogue.items.some((i) => i.installed);
  if (!untouched) return { install: [], markAttempted: true };

  // Skip what this platform is not offered: the bundle is one list of ids for
  // every OS, and queueing an install that cannot succeed would turn a silent
  // first run into a failed one. (macOS is offered two of the five.)
  const install = catalogue.items
    .filter((item) => bundle.packageIds.includes(item.id) && item.available && !item.installed)
    .map((item) => item.id);

  return { install, markAttempted: true };
}
