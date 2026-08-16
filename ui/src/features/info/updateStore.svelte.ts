/**
 * The result of the update check, shared by the two things that show it: the
 * start-up notice and the About dialog's manual check. Module-level state
 * rather than a prop chain so both agree on one answer and one request is made
 * per launch, however often the dialog is opened.
 *
 * Holds only what came back. Whether it is worth *showing* is decided by the
 * pure rules in `updateCheck.ts`, which the notice and the dialog apply
 * differently — the notice honours the user's dismissal, the dialog does not.
 */
import { untrack } from 'svelte';
import { fetchLatestReleaseTag } from './updateCheck';

export type UpdateCheckPhase = 'idle' | 'checking' | 'checked' | 'failed';

let phase = $state<UpdateCheckPhase>('idle');
let latest = $state('');

export function updatePhase(): UpdateCheckPhase {
  return phase;
}

/** The newest published version, empty until a check has succeeded. */
export function latestVersion(): string {
  return latest;
}

/** Run the check, at most once per launch unless `force`.
 *
 * A *failed* check is always retried, though: offline at launch is the common
 * case, and by the time the user opens About the network may well be back. */
export async function checkForUpdate(force = false): Promise<void> {
  // Untracked, and this must stay the only read of `phase` in this function:
  // both callers run it from an `$effect`, so a tracked read would make that
  // effect depend on the phase this function immediately sets. The effect
  // re-runs, calls in again — and because 'failed' is not a terminal phase,
  // a failing check would retry forever instead of once.
  const current = untrack(() => phase);
  if (current === 'checking' || (current === 'checked' && !force)) return;
  phase = 'checking';
  const tag = await fetchLatestReleaseTag();
  latest = tag ?? '';
  phase = tag === null ? 'failed' : 'checked';
}
