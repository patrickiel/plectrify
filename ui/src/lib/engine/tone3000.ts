/**
 * TONE3000 — the types the UI works in, and the pure rules that go with them.
 *
 * The engine does all the talking: every API call, every token and every
 * downloaded byte lives on the native side (see Source/tone3000). What crosses
 * the bridge is already flattened into the shapes below, so nothing here knows
 * the API's own field names, and nothing here fetches.
 *
 * Enum-like values are plain `string`, deliberately. TONE3000 adds gear types,
 * formats and licences without asking us, and a patch on disk may name one this
 * build has never heard of — the same rule `isStoredPatch` already follows, for
 * the same reason: an unknown value must degrade, never reject.
 */

/** Where a patch's capture came from.
 *
 * Present only on patches created from TONE3000. It is what lets the drawer
 * show the tone's artwork and creator, what makes attribution possible at all,
 * and what a repair uses to fetch the model again — so it is not derived from
 * anything else, and every path that rebuilds a patch document has to carry it
 * forward explicitly (see `updatePatch` in both engines). */
export interface Tone3000Provenance {
  toneId: number;
  modelId: number;
  /** Title, gear and format as published when this was downloaded. A copy
      rather than a lookup: the drawer has to be readable offline, and a tone
      renamed upstream should not silently rename the user's patch. */
  title: string;
  gear: string;
  format: string;
  modelName?: string;
  size?: string;
  architecture?: string;
  creator: { id?: string; username: string; avatarUrl?: string; url?: string };
  /** The tone's licence id ('t3k', 'cc-by', 'cc-by-sa', …). Stored because
      attribution is an obligation under TONE3000's terms, not a nicety. */
  license?: string;
  /** Canonical tone page — where the T3K mark links to. */
  url?: string;
  imageUrl?: string;
  /** Every capture this tone offers, in TONE3000's own order, with the names
      its creator gave them ("TB Brl 3", "Nrm 2" — channel and gain setting).
      A tone is usually several takes of one amp, and which suits a song is only
      answered by hearing them, so the whole set is downloaded and the module
      switches between them offline. Absent on a patch made before this, which
      simply has no switcher. */
  models?: Tone3000Variant[];
  /** Where the model landed, relative to the engine's download root
      ('nam/12345-67890.nam'). Derived from the ids alone, so re-downloading on
      another machine restores exactly the path the plugin state already names. */
  file: string;
  downloadedAt?: string;
}

/** One of a tone's captures, as offered by the module's variant switcher. */
export interface Tone3000Variant {
  modelId: number;
  name: string;
  size?: string;
  architecture?: string;
  /** Relative to the download root, derived from the ids — the same rule
      `file` follows, so it is valid on any machine that has the tone. */
  file: string;
}

/** What this build's API key may actually do.
 *
 * `prompt` is TONE3000's free tier: the select_tone and load_tone flows plus
 * the bounded list endpoints. `full` adds search. Everything Plectrify does is a
 * prompt flow — browsing happens on TONE3000's own pages, in their own window —
 * so this now says whether the account is usable at all rather than which parts
 * of an in-app browser to show. */
export type Tone3000ApiAccess = 'none' | 'prompt' | 'full';

export interface Tone3000User {
  id?: string;
  username: string;
  avatarUrl?: string;
}

export interface Tone3000Download {
  toneId: number;
  modelId: number;
  file: string;
  bytes: number;
}

export interface Tone3000State {
  connected: boolean;
  /** A sign-in window is open. The UI shows it is waiting without owning that
      window's lifetime — the engine closes it, however the user leaves it. */
  pending: boolean;
  user?: Tone3000User;
  apiAccess: Tone3000ApiAccess;
  /** Whether the partnership splash has been shown. Persisted natively, not in
      app settings, so it survives a disconnect and the page cannot clear it. */
  splashSeen: boolean;
  /** Everything on disk, read back after every install — the disk truth the
      page reconciles from rather than trusting the progress stream. */
  downloads: Tone3000Download[];
  error?: string;
}

export interface Tone3000Creator {
  id?: string;
  username: string;
  avatarUrl?: string;
  url?: string;
}

/** One tone, carrying everything a list row must show: image, title, gear
    type, format and creator (TONE3000's design requirements for any list or
    grid of tones). */
export interface Tone3000Tone {
  id: number;
  title: string;
  description?: string;
  gear: string;
  format: string;
  license?: string;
  url?: string;
  imageUrl?: string;
  creator: Tone3000Creator;
  modelsCount?: number;
  downloadsCount?: number;
  favoritesCount?: number;
}

export interface Tone3000Model {
  id: number;
  toneId: number;
  name: string;
  size?: string;
  architecture?: string;
  /** The engine downloads this; the page only passes it back. */
  url: string;
}

/** The formats Plectrify can play, in the order a tone's models are considered.
    Which model of a multi-model tone is downloaded is decided natively — see
    `Tone3000Library::chooseModel`, which is where that rule lives in one
    place — so nothing here picks. */
export type Tone3000InstallStage = 'queued' | 'downloading' | 'building' | 'done' | 'failed';

export interface Tone3000InstallEvent {
  runId: string;
  stage: Tone3000InstallStage;
  received?: number;
  total?: number;
  error?: string;
  /** The tone's title, so a run started in a window the page never saw can
      still be named while it downloads. */
  title?: string;
  /** The patch the finished run produced. What the drawer reveals and what a
      pending rack drop instantiates. */
  patchId?: string;
  /** Set when the download succeeded but the plugin's state could not be
      rewritten — the file is on disk and usable, only the hand-off failed, so
      the UI offers the path rather than pretending nothing happened. */
  path?: string;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/** The formats Plectrify can play. Neural Amp Modeler loads a capture in its model
    slot and an impulse response in its IR slot, so one plugin covers both;
    aida-x, proteus and aa-snapshot have no host here and are filtered out of
    the catalogue rather than downloaded and left unusable. */
export const TONE3000_FORMATS = ['nam', 'ir'] as const;

/** The plugin every TONE3000 tone loads into: a capture in its model slot, an
    impulse response in its IR slot. Matched against `RackModule.name`, which is
    the plugin's own name and the same key a patch is matched by. One constant,
    because the drawer, the rack and the engine all have to agree on it. */
export const NAM_PLUGIN_NAME = 'NeuralAmpModeler';

/** Is this module hosting Neural Amp Modeler?
 *
 * Matched loosely on purpose. The plugin reports itself as "NeuralAmpModeler",
 * the catalogue lists it as "Neural Amp Modeler", and TONE3000 writes it both
 * ways — so an exact comparison silently decides the plugin is not installed,
 * which shows the user an "install it first" button for something they already
 * have. Spacing and case are not identity here. */
export function isNamPlugin(name: string | undefined): boolean {
  return name?.replace(/\s+/g, '').toLowerCase() === 'neuralampmodeler';
}

export const FORMAT_LABELS: Record<string, string> = {
  nam: 'NAM',
  ir: 'IR',
};

export const GEAR_LABELS: Record<string, string> = {
  amp: 'Amp',
  'amp-cab': 'Amp + Cab',
  'full-rig': 'Amp + Cab',
  pedal: 'Pedal',
  outboard: 'Outboard',
  cab: 'Cabinet',
  space: 'Space',
  experimental: 'Experimental',
  ir: 'IR',
};

/** An unknown id prints as itself rather than as "Unknown": TONE3000 owns this
    vocabulary and will add to it, and a raw slug still tells the user more than
    a placeholder does. */
export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

export function gearLabel(gear: string): string {
  return GEAR_LABELS[gear] ?? gear;
}

/** TONE3000's own names for the neural model architectures: A2 is the current
    default, A1 the legacy one, and Custom covers user-supplied architectures.
    Their vocabulary, printed their way — "Architecture 2" is our paraphrase and
    does not appear anywhere the user might have read it. */
export const ARCHITECTURE_LABELS: Record<string, string> = {
  '1': 'A1',
  '2': 'A2',
  custom: 'Custom',
};

export function architectureLabel(architecture: string | undefined): string {
  if (!architecture) return '';
  return ARCHITECTURE_LABELS[architecture] ?? architecture;
}

/** The knob mapping a TONE3000 patch starts from — the factory value of the
 * user-editable template in Settings (`AppSettings.tone3000TemplateKnobs`),
 * and what "Reset to default" restores.
 *
 * Neural Amp Modeler's parameter order: gain and gate on the left, the tone
 * stack across the middle, output last. Stated here rather than read from
 * anything installable — a default that disappears when a package is removed is
 * not a default.
 *
 * A downloaded tone has to be playable the moment it lands. Without a mapping
 * the module card comes up with empty slots and the user has to go find each
 * parameter by index before they can turn anything, which is not what anyone
 * meant by "download this tone".
 *
 * Positions are the module card's column-major grid (see knobLayout.ts). The
 * indices are NAM 0.7.x's; a future NAM that reorders its parameters would want
 * this revisited, which is why the labels are spelled out rather than derived.
 */
export const NAM_DEFAULT_KNOBS: readonly { paramIndex: number; label: string; pos: number }[] = [
  { paramIndex: 1, label: 'Input', pos: 1 },
  { paramIndex: 2, label: 'Threshold', pos: 3 },
  { paramIndex: 3, label: 'Bass', pos: 0 },
  { paramIndex: 4, label: 'Middle', pos: 2 },
  { paramIndex: 5, label: 'Treble', pos: 4 },
  { paramIndex: 6, label: 'Output', pos: 5 },
];

/** A fresh copy, since a patch document owns its own knobs. */
export function namDefaultKnobs(): { paramIndex: number; label: string; pos: number }[] {
  return NAM_DEFAULT_KNOBS.map((k) => ({ ...k }));
}

export function isSupportedFormat(format: string): boolean {
  return (TONE3000_FORMATS as readonly string[]).includes(format);
}

/**
 * Is this a provenance record we can work with?
 *
 * Lenient on purpose, and in the same spirit as `isStoredPatch`: only the
 * fields something actually depends on are checked — the ids and file a repair
 * needs, the title and format the drawer prints, the username attribution
 * requires. Everything else, known or not, is carried through untouched. A
 * patch whose provenance is garbage is still a perfectly good patch; it just
 * loses its TONE3000 identity, which is a far better outcome than refusing to
 * load the file at all.
 */
export function isTone3000Provenance(value: unknown): value is Tone3000Provenance {
  const p = value as Partial<Tone3000Provenance> | null;
  return (
    typeof p?.toneId === 'number' &&
    typeof p?.modelId === 'number' &&
    typeof p?.title === 'string' &&
    typeof p?.format === 'string' &&
    typeof p?.file === 'string' &&
    p.file.length > 0 &&
    typeof p?.creator === 'object' &&
    p.creator !== null &&
    typeof p.creator.username === 'string'
  );
}

/** The root heading every downloaded tone files under — also what pins the
    TONE3000 sections to the front of the drawer's list (see `groupPatches`),
    so the two must stay one string. */
export const TONE3000_HEADING = 'TONE3000';

/** The drawer heading a TONE3000 patch files under, as a category path.
 *
 * Two levels, so twenty downloaded tones organise themselves into
 * TONE3000 › Amp + Cab, TONE3000 › Pedal and so on with no new UI code — the
 * drawer already renders category paths as a tree. */
export function tone3000Category(provenance: Tone3000Provenance): string[] {
  return [TONE3000_HEADING, gearLabel(provenance.gear)];
}

/** The patch a downloaded tone would duplicate, if the user already has one.
 *
 * Downloading is one click on TONE3000's own pages and nothing over there says
 * what is already in the rig, so picking the same tone twice is the ordinary
 * mistake, not the exotic one — and it used to leave two identically titled
 * tiles in the drawer, wearing the same photograph, backed by the same file on
 * disk. The second one is not a second tone; it is the same tone downloaded
 * again.
 *
 * Matched on `toneId` alone, because a tone's models are the same capture at
 * different weights and the module already switches between them offline (see
 * `models` above) — so the tone, not the take, is what one patch stands for.
 * An exact model match is preferred among several candidates, which is what
 * makes re-downloading the very same capture rewrite nothing at all; the id
 * breaks ties, so the answer does not depend on the order the directory was
 * read in. Only the user's own patches are ever passed here: a shipped pack's
 * are read-only, so one could never be the patch this download lands in. */
export function findTone3000Patch<T extends { id: string; tone3000?: Tone3000Provenance }>(
  patches: readonly T[],
  provenance: Pick<Tone3000Provenance, 'toneId' | 'modelId'>,
): T | undefined {
  const sameTone = patches
    .filter((p) => p.tone3000?.toneId === provenance.toneId)
    .sort((a, b) => a.id.localeCompare(b.id));
  return sameTone.find((p) => p.tone3000?.modelId === provenance.modelId) ?? sameTone[0];
}

/** Which of these patches point at a model that is no longer on disk.
 *
 * Takes the engine's answer (`missing`) and the patch list, and reports the
 * patch ids to mark rather than the files — the UI thinks in patches, and one
 * file may back several patches once a tone is saved twice. */
export function patchesMissingCaptures<T extends { id: string; tone3000?: Tone3000Provenance }>(
  patches: T[],
  missing: readonly string[],
): Set<string> {
  const gone = new Set(missing);
  const ids = new Set<string>();
  for (const patch of patches)
    if (patch.tone3000 && gone.has(patch.tone3000.file)) ids.add(patch.id);
  return ids;
}

/** Every distinct model file the given patches depend on — what `verify` is
    asked about, and what a "remove unused downloads" action must spare. */
export function referencedFiles<T extends { tone3000?: Tone3000Provenance }>(
  patches: T[],
): string[] {
  const files = new Set<string>();
  for (const patch of patches) if (patch.tone3000?.file) files.add(patch.tone3000.file);
  return [...files];
}
