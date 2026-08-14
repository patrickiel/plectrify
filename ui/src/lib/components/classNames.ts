import type { ClassValue } from 'svelte/elements';
import { extendTailwindMerge } from 'tailwind-merge';

const merge = extendTailwindMerge({
  extend: {
    theme: {
      animate: ['learn-pulse'],
      radius: ['control-xs', 'control-sm', 'control-md', 'control-lg'],
    },
  },
});

type ClassInput = ClassValue | false | null | undefined | number | bigint;

/** Flatten Svelte's object-capable class values, then resolve Tailwind conflicts. */
export function cn(...values: ClassInput[]): string {
  const classes: string[] = [];
  for (const value of values) flatten(value, classes);
  return merge(classes);
}

function flatten(value: ClassInput, target: string[]): void {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    target.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, target);
    return;
  }
  for (const [name, enabled] of Object.entries(value)) {
    if (enabled) target.push(name);
  }
}
