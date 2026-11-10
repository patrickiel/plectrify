/**
 * Which TONE3000 cover art is on disk, shared by the three places that show it
 * (drawer tile, module card, badge). Module-level state rather than a prop
 * chain, like the update store: the answer is one fact about the machine, and
 * the components that need it sit at the bottom of three different trees.
 *
 * App.svelte feeds it from the engine's tone3000State; the rule for what may
 * be shown is `tone3000ArtworkUrl` in lib/engine/tone3000.ts.
 */
import {
  NO_TONE3000_ARTWORK,
  tone3000ArtworkUrl,
  type Tone3000ArtworkCache,
  type Tone3000Provenance,
  type Tone3000State,
} from '../../lib/engine/tone3000';

let cache = $state<Tone3000ArtworkCache>(NO_TONE3000_ARTWORK);

export function setTone3000Artwork(state: Tone3000State): void {
  cache = { root: state.artworkRoot ?? '', cached: new Set(state.artwork ?? []) };
}

/** Reactive: re-evaluates when a picture lands on disk. */
export function tone3000Artwork(
  provenance: Pick<Tone3000Provenance, 'toneId' | 'imageUrl'> | undefined,
): string | undefined {
  return tone3000ArtworkUrl(provenance, cache);
}
