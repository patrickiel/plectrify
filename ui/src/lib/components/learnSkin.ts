/**
 * The one description of "what does MIDI learn make this control look like".
 *
 * Every learnable control used to restate the same three lines at its call
 * site — `class:learn-target={learn.on}`, `class:learn-armed={…}`,
 * `class:learn-bound={…}` — and then re-declare the matching CSS in its own
 * panel. That is now one prop and one skin: {@link learnRingClass} is what both
 * Button and the custom-shaped controls (the looper pedal) wear, so a mapped
 * verb and a mapped pedal are visibly the same thing.
 *
 * The skin is an *outline*, never a border: an outline is drawn outside the
 * layout box and follows the element's own `border-radius`, so a control keeps
 * its resting chrome and shape underneath and nothing reflows when learn mode
 * flips on.
 *
 * It also settles a disagreement the copies had drifted into: the setlist's
 * transport only showed `bound` while learn mode was on, the looper's verbs
 * showed it always. Off-mode is now uniformly plain — outside learn mode a
 * control should look like what it does, not like what it is mapped to.
 */
import type { MidiLearnApi } from './MidiLearn.svelte';
import type { MidiActionId } from '../engine/types';

/**
 * `off` while the card is not learning; otherwise `armed` (listening for this
 * one press), `bound` (already mapped, click clears), or `target` (mappable).
 */
export type LearnState = 'off' | 'target' | 'armed' | 'bound';

// Shared by all three live states so their geometry can't drift apart: the
// same weight, the same inset, the same colour channel. Only `--learn-edge`
// and the dash/fill change between them.
const learnBase =
  'cursor-pointer outline-2 -outline-offset-2 [outline-color:var(--learn-edge)] motion-reduce:animate-none';

// The three states climb one ladder — dashed → solid → solid-and-pulsing,
// faint → strong → full accent — so "how far along is this control" is
// readable without reading the tooltip.
const ringClassByState: Record<Exclude<LearnState, 'off'>, string> = {
  target: 'outline-dashed [--learn-edge:color-mix(in_srgb,var(--color-accent)_45%,transparent)]',
  bound:
    'outline-solid [--learn-edge:color-mix(in_srgb,var(--color-accent)_70%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent',
  armed: 'animate-learn-pulse outline-solid [--learn-edge:var(--color-accent)] text-accent',
};

/** The learn skin for one control. `off` renders plain. */
export function learnRingClass(state: LearnState): string | undefined {
  return state === 'off' ? undefined : `${learnBase} ${ringClassByState[state]}`;
}

/**
 * The compact flavour, for the little piano-key toggles that *start* a learn
 * rather than being a learn target — the rack's per-lane and per-module
 * buttons, the tuner's. They are ~22px, so a 2px inset outline would swallow
 * the icon: these draw on their own 1px border instead. The colours are the
 * ladder's, so `bound` and `armed` still read the same everywhere.
 */
export function learnBadgeClass(state: 'off' | 'bound' | 'armed'): string | undefined {
  if (state === 'off') return undefined;
  return state === 'bound'
    ? 'border-[color:color-mix(in_srgb,var(--color-accent)_70%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent'
    : 'animate-learn-pulse border-accent text-accent motion-reduce:animate-none';
}

export function learnStateOf<A extends MidiActionId>(api: MidiLearnApi<A>, action: A): LearnState {
  if (!api.on) return 'off';
  if (api.armed === action) return 'armed';
  return api.bound(action) ? 'bound' : 'target';
}
