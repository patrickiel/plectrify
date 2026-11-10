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
 * otherwise unreadable.
 */

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Layers this deep cannot come from a plausible number of saves; the cap only
    bounds the loop. */
const MAX_LAYERS = 32;

function peelOnce(text: string): string | null {
  let nonAscii = false;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return null;
    if (code > 0x7f) nonAscii = true;
    bytes[i] = code;
  }
  if (!nonAscii) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The string with every layer of Latin-1-read UTF-8 removed; unchanged when
    it carries none. */
export function repairMojibake(text: string): string {
  let current = text;
  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    const peeled = peelOnce(current);
    if (peeled === null || peeled === current) break;
    current = peeled;
  }
  return current;
}

/** A JSON.parse reviver applying repairMojibake to every string value. Keys
    are left as they are: every key the page writes is ASCII. */
export function mojibakeReviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? repairMojibake(value) : value;
}
