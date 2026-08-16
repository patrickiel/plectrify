import { describe, expect, it } from 'vitest';
import { cn } from './classNames';

describe('cn', () => {
  it('flattens Svelte class arrays and objects', () => {
    expect(cn('flex', ['gap-1', false, { 'text-accent': true, hidden: false }])).toBe(
      'flex gap-1 text-accent',
    );
  });

  it('recognises Plectrify theme radii', () => {
    expect(cn('rounded-control-sm', 'rounded-full')).toBe('rounded-full');
  });
});
