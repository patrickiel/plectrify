/**
 * Which input jack the guitar is in, answered by listening rather than asked.
 *
 * This is the one setting nobody can be expected to know: interfaces number
 * their jacks from 1 and their drivers from 0, "Input 2" on the box is often
 * channel 1 in the list, and picking wrong is silence with nothing on screen to
 * explain it. So the wizard shows a meter per channel, asks for a strum, and
 * watches — and this is the rule that decides when what it has seen is an
 * answer rather than a room.
 *
 * Deliberately not "the loudest channel". Something is always loudest, and a
 * detector that always has an opinion is one that confidently selects the
 * webcam microphone. Two conditions have to hold together: the channel has to
 * be genuinely *audible*, and it has to be clearly louder than every other one.
 * Until both do, the honest answer is none.
 */

/** How loud a channel must have been, at its loudest, to count as played at
    all: -34 dBFS. Above any interface's noise floor and any hum a nearby
    unplugged cable picks up, and far below what a guitar reaches even played
    quietly through a low-output pickup. */
export const INPUT_FLOOR = 0.02;

/** How far a channel must stand above the runner-up: ×4, or +12 dB. A guitar
    against a silent jack clears this many times over; a room that two
    microphones can both hear never does, and neither does the crosstalk one
    hot input induces in its neighbour. */
export const INPUT_MARGIN = 4;

/**
 * The channel carrying the guitar, or null while that is not yet clear.
 *
 * `maxima` is each channel's loudest peak *so far* — a running maximum, not an
 * instantaneous level. That matters: a strum is one moment and a poll is 15 a
 * second, so a rule reading the current frame would answer during the silence
 * between two chords. Holding the maximum means the question is "what has this
 * jack ever carried", which only ever gains information.
 *
 * A single-channel device is answered without any of this: there is nothing to
 * distinguish it from, and refusing to name the only jack there is would leave
 * the step unanswerable.
 */
export function detectInputChannel(
  maxima: readonly number[],
  floor = INPUT_FLOOR,
  margin = INPUT_MARGIN,
): number | null {
  if (maxima.length === 0) return null;
  if (maxima.length === 1) return maxima[0] >= floor ? 0 : null;

  let best = 0;
  let runnerUp = 0;
  for (let channel = 1; channel < maxima.length; channel += 1) {
    if (maxima[channel] > maxima[best]) best = channel;
  }
  for (let channel = 0; channel < maxima.length; channel += 1) {
    if (channel !== best && maxima[channel] > runnerUp) runnerUp = maxima[channel];
  }

  if (maxima[best] < floor) return null;
  if (maxima[best] < runnerUp * margin) return null;
  return best;
}

/**
 * Fold a fresh set of peaks into the running maxima.
 *
 * Resizes to whatever the engine last reported, because the channel list moves
 * under this the moment the user changes device — and a maximum held over from
 * the previous interface would answer for a jack that is no longer there.
 */
export function accumulatePeaks(maxima: readonly number[], peaks: readonly number[]): number[] {
  return peaks.map((peak, channel) => Math.max(peak, maxima[channel] ?? 0));
}

/** A linear peak as a meter fill, 0..1, over the same -60 dB span the status
    bar's meters use — so a level looks the same here as it will there. */
export function meterFill(peak: number): number {
  if (peak <= 0.000001) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
