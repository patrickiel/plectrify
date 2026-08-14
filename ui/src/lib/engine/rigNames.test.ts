import { describe, expect, it } from 'vitest';
import { nextRigName } from './rigNames';

describe('nextRigName', () => {
  it('starts at Rig 1 with no rigs', () => {
    expect(nextRigName([])).toBe('Rig 1');
  });

  it('continues past a dense sequence', () => {
    expect(nextRigName(['Rig 1', 'Rig 2'])).toBe('Rig 3');
  });

  it('fills the gap left by a deleted rig instead of colliding', () => {
    expect(nextRigName(['Rig 2', 'Rig 3'])).toBe('Rig 1');
    expect(nextRigName(['Rig 1', 'Rig 3'])).toBe('Rig 2');
  });

  it('ignores names outside the default scheme', () => {
    expect(nextRigName(['Lead', 'Clean Chorus', 'Rig 1'])).toBe('Rig 2');
  });
});
