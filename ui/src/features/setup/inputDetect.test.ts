import { describe, expect, it } from 'vitest';
import { INPUT_FLOOR, accumulatePeaks, detectInputChannel, meterFill } from './inputDetect';

describe('detectInputChannel', () => {
  it('names the channel that is both loud and alone', () => {
    expect(detectInputChannel([0.001, 0.4, 0.002, 0.001])).toBe(1);
  });

  it('says nothing while every channel is at a noise floor', () => {
    // The whole point: something is always loudest, and a detector that always
    // has an opinion is one that confidently selects the webcam microphone.
    expect(detectInputChannel([0.003, 0.005, 0.002])).toBeNull();
  });

  it('says nothing when two channels hear the same thing', () => {
    // A room two microphones can both hear, or one hot input bleeding into its
    // neighbour. Loud enough, but not an answer.
    expect(detectInputChannel([0.5, 0.3, 0.001])).toBeNull();
  });

  it('answers once the loud channel clears the margin', () => {
    expect(detectInputChannel([0.5, 0.1, 0.001])).toBe(0);
  });

  it('holds out for the floor even with nothing to compete against', () => {
    // Ten times the runner-up, and still inaudible: a jack picking up hum is
    // not a guitar.
    expect(detectInputChannel([0.004, 0.0001])).toBeNull();
  });

  it('names the only channel of a one-input device once it is played', () => {
    // Nothing to distinguish it from, so the margin cannot apply — but the
    // floor still has to be cleared, or a silent mic would answer the step.
    expect(detectInputChannel([0.3])).toBe(0);
    expect(detectInputChannel([0.001])).toBeNull();
    expect(detectInputChannel([INPUT_FLOOR])).toBe(0);
  });

  it('has nothing to say about a device with no inputs', () => {
    expect(detectInputChannel([])).toBeNull();
  });
});

describe('accumulatePeaks', () => {
  it('keeps each channel at its loudest', () => {
    // A strum is one moment and the poll runs at 15 Hz, so the running maximum
    // is what makes the question "what has this jack ever carried" rather than
    // "what is it carrying between two chords".
    expect(accumulatePeaks([0.1, 0.5], [0.4, 0.2])).toEqual([0.4, 0.5]);
  });

  it('resizes to the channels the engine now reports', () => {
    // The list moves the moment the user changes device, and a maximum held
    // over from the previous interface would answer for a jack that is gone.
    expect(accumulatePeaks([0.9, 0.9, 0.9], [0.1, 0.2])).toEqual([0.9, 0.9]);
    expect(accumulatePeaks([0.9], [0.1, 0.2])).toEqual([0.9, 0.2]);
  });
});

describe('meterFill', () => {
  it('spans -60 dB, like the status bar', () => {
    expect(meterFill(1)).toBe(1);
    expect(meterFill(0.001)).toBeCloseTo(0, 5);
    expect(meterFill(0)).toBe(0);
    expect(meterFill(0.5)).toBeCloseTo(0.9, 1);
  });
});
