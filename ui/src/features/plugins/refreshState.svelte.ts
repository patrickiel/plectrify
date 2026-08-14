import type { EngineBridge } from '../../lib/engine/EngineBridge';

/**
 * The Packages panel's refresh, as state shared between the two places that
 * need it: the title-bar button that starts it (ToolSidebar) and the panel that
 * learns it finished (PluginsPanel, which is what receives the fresh
 * catalogue).
 *
 * A module-level rune rather than a prop chain because the two components are
 * siblings — the button sits in the sidebar's header, the subscription in the
 * panel body — and threading a callback up and a phase back down through
 * ToolSidebar would put plugin-catalogue plumbing into a component that
 * otherwise knows nothing about it.
 *
 * `refreshCatalogue` is fire-and-forget over the bridge: it has no reply of
 * its own, and the only sign it worked is a fresh `catalogueState` arriving.
 * So "finished" is inferred from that push, with a timeout in case it is
 * dropped while the window is occluded.
 */
export type RefreshPhase = 'idle' | 'checking' | 'checked';

let phase = $state<RefreshPhase>('idle');

/** Both must be true before the spinner stops: the catalogue has landed, and
    the spinner has been up long enough to be seen. A Debug build reads the
    catalogue off local disk in a millisecond, which without this reads as the
    button doing nothing at all. */
let arrived = false;
let minimumElapsed = false;

let minimumTimer: ReturnType<typeof setTimeout> | undefined;
let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** Long enough to register as a deliberate spin, short enough not to feel like
    the app is slow. */
const MINIMUM_SPIN_MS = 450;
/** A push can be dropped while the window is occluded; the icon must not spin
    for ever because of it. */
const GIVE_UP_MS = 8000;
/** How long the outcome stays on screen before the row goes quiet again. */
const CLEAR_MS = 4000;

export function refreshPhase(): RefreshPhase {
  return phase;
}

function settle(): void {
  if (phase !== 'checking' || !arrived || !minimumElapsed) return;

  phase = 'checked';
  clearTimeout(giveUpTimer);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => (phase = 'idle'), CLEAR_MS);
}

/** Starts a refresh and puts the button into its spinning state. */
export function requestRefresh(engine: EngineBridge): void {
  if (phase === 'checking') return;

  clearTimeout(minimumTimer);
  clearTimeout(giveUpTimer);
  clearTimeout(clearTimer);

  arrived = false;
  minimumElapsed = false;
  phase = 'checking';

  minimumTimer = setTimeout(() => {
    minimumElapsed = true;
    settle();
  }, MINIMUM_SPIN_MS);

  // Settles regardless of whether the push arrives, so a dropped event costs a
  // stale-looking answer rather than a spinner that never stops.
  giveUpTimer = setTimeout(() => {
    arrived = true;
    minimumElapsed = true;
    settle();
  }, GIVE_UP_MS);

  engine.refreshCatalogue();
}

/** Called by the panel whenever a catalogue lands. Ignored unless a refresh is
    actually in flight — the panel also receives pushes it did not ask for. */
export function noteCatalogueArrived(): void {
  if (phase !== 'checking') return;

  arrived = true;
  settle();
}
