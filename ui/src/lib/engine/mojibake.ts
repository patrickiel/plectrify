/**
 * Undoing the text damage the Linux build's web-view bridge did before it was
 * fixed (issue #48).
 *
 * JUCE's WebKitGTK backend carried every event over a pipe written as UTF-8
 * and read back as 8-bit characters, so each crossing turned a non-ASCII
 * character into the Latin-1 reading of its UTF-8 bytes: "®" became "Â®", and
 * the next crossing turned that into "Ã\u0082Â®". Anything the page saved and
 * read again went through more crossings each time, so patch names, TONE3000
 * credits, rig names and module titles on disk carry several layers of it.
 * The pipe is patched now (cmake/juce-linux-webkit-utf8-ipc.patch); this reads
 * what it already wrote.
 *
 * One layer is peeled while the string looks exactly like such a layer: every
 * character fits in a byte, at least one is non-ASCII, and those bytes are
 * well-formed UTF-8. Text that was never damaged almost never passes the last
 * test — a lone "é" or "®" is not valid UTF-8 as a byte — so real accented
 * names are left alone. The cost of the rare false positive (a name that
 * really is written "Ã©") is one character changed, against names that are
 * otherwise unreadable. It is a heuristic all the same, which is why it is run
 * once over the documents that can carry the damage and never again — see
 * `repairStoredText` in JuceEngine.ts.
 *
 * One thing the page did to a damaged string stops it being exactly such a
 * layer, and has a rule of its own below: it lost its end. A clamp (a song's
 * notes are cut to a fixed length on every load) or a trim (a trailing U+00A0
 * is whitespace, and it is the last byte of "à") leaves a sequence unfinished
 * at the very end. A damaged name that undamaged text was typed onto is not
 * repaired: nothing short of guessing tells its two halves apart.
 */

/** Any character a damaged string must contain. Asked before anything is
    allocated: this runs over every string of every document, a plugin's
    megabytes of base64 state included. */
const LATIN1_HIGH = /[\u0080-\u00ff]/;

const NBSP = '\u00a0';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** How many continuation bytes the lead byte `code` announces; 0 when it is
    not a lead. */
function continuationsAfter(code: number): number {
  if (code >= 0xc2 && code <= 0xdf) return 1;
  if (code >= 0xe0 && code <= 0xef) return 2;
  if (code >= 0xf0 && code <= 0xf4) return 3;
  return 0;
}

const isContinuation = (code: number): boolean => code >= 0x80 && code <= 0xbf;

/** The UTF-8 reading of a string whose every character is one byte; null when
    a character is wider than that or the bytes are not well-formed. */
function decodeBytes(text: string): string | null {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return null;
    bytes[i] = code;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** One whole layer off, or null when the string is not exactly one. */
function peelWhole(text: string): string | null {
  return LATIN1_HIGH.test(text) ? decodeBytes(text) : null;
}

interface Repair {
  text: string;
  /** Whole layers taken off — what two readings of an ambiguous end are
      compared by. */
  layers: number;
}

/** Every whole layer off. It ends: a layer is shorter than the string it was
    read from. */
function peelWholeLayers(text: string): Repair {
  let current = text;
  let layers = 0;
  for (;;) {
    const peeled = peelWhole(current);
    if (peeled === null) return { text: current, layers };
    current = peeled;
    layers++;
  }
}

/**
 * A layer whose last sequence was cut short, read both ways it can be.
 *
 * `dropped` is the layer without the unfinished sequence, which is all that
 * can be said after a clamp. `completed` supplies the one byte a trim takes:
 * U+00A0 is the last byte of "à" and the page trims names, so "Città" lost
 * exactly that. Null unless the rest of the string is a layer in its own
 * right — an unfinished sequence alone is how "IRMÃ" is spelled.
 */
function peelTruncated(text: string): { dropped: string; completed: string | null } | null {
  let start = text.length - 1;
  let present = 0;
  while (start >= 0 && present < 3 && isContinuation(text.charCodeAt(start))) {
    start--;
    present++;
  }
  if (start < 0) return null;
  const lead = text.charCodeAt(start);
  const missing = continuationsAfter(lead) - present;
  if (missing <= 0) return null;
  // "Ã" and "Â" open every sequence of a second or deeper layer, and a lead
  // that already has continuations is no word's last letter. Any other lone
  // lead is left: it is as likely an "é" typed onto the end.
  if (present === 0 && lead !== 0xc2 && lead !== 0xc3) return null;

  const dropped = peelWhole(text.slice(0, start));
  if (dropped === null) return null;
  return { dropped, completed: missing === 1 ? decodeBytes(text + NBSP) : null };
}

function repair(text: string): Repair {
  const whole = peelWholeLayers(text);
  const cut = peelTruncated(whole.text);
  if (cut === null) return whole;

  // The same characters come from a clamp and from a trim, so the reading that
  // explains at least as many layers wins: a trimmed name then comes back
  // exactly, and a clamped note is one character out at its cut end either way.
  let best = repair(cut.dropped);
  if (cut.completed !== null) {
    const completed = peelWholeLayers(cut.completed);
    if (completed.layers >= best.layers) best = completed;
  }
  return { text: best.text, layers: whole.layers + 1 + best.layers };
}

/** The string with every layer of Latin-1-read UTF-8 removed; unchanged when
    it carries none. */
export function repairMojibake(text: string): string {
  return LATIN1_HIGH.test(text) ? repair(text).text : text;
}

/** The object with its damaged keys repaired, or itself when none is. Not
    every key is a fixed word: the drawer's hand ordering is keyed by patch
    category, which the user typed. */
function repairKeys(record: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(record);
  if (!keys.some((key) => repairMojibake(key) !== key)) return record;
  return Object.fromEntries(keys.map((key) => [repairMojibake(key), record[key]]));
}

/** A JSON.parse reviver applying repairMojibake to every string value and
    every object key. */
export function mojibakeReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return repairMojibake(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return repairKeys(value as Record<string, unknown>);
  }
  return value;
}

/** A stored JSON document with its text repaired, serialised the way the page
    writes one; null when nothing in it needed repair, or it is not JSON. */
export function repairJsonDocument(text: string): string | null {
  if (!LATIN1_HIGH.test(text)) return null;
  let changed = false;
  let doc: unknown;
  try {
    doc = JSON.parse(text, (key, value: unknown) => {
      const revived = mojibakeReviver(key, value);
      if (revived !== value) changed = true;
      return revived;
    });
  } catch {
    return null;
  }
  return changed ? JSON.stringify(doc, null, 2) : null;
}
