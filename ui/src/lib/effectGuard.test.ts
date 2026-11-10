import { describe, expect, it } from 'vitest';

/**
 * `$effect` is an escape hatch, not a way to keep state in sync (AGENTS.md,
 * *Code style*): derived state is `$derived`, a reaction to something the user
 * did belongs in that handler, and DOM wiring is an `{@attach}`. So every
 * effect that survives says why it is one, in a `// Effect: …` line in the
 * comment directly above it — which is what this checks, over the app and the
 * site alike, so the rule cannot erode one unexplained effect at a time.
 */
const sources = {
  ...import.meta.glob<string>(['/src/**/*.svelte', '/src/**/*.svelte.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>(
    ['../../../site/src/**/*.svelte', '../../../site/src/**/*.svelte.ts'],
    {
      query: '?raw',
      import: 'default',
      eager: true,
    },
  ),
};

const EFFECT = /\$effect(\.pre)?\s*\(/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const JUSTIFIED = /^\s*\/\/\s*Effect:/;

/** `file:line` of every effect without a justification in the comment above. */
function unjustifiedEffects(file: string, source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!EFFECT.test(line) || COMMENT.test(line)) return;
    let above = index - 1;
    let justified = false;
    while (above >= 0 && COMMENT.test(lines[above])) {
      if (JUSTIFIED.test(lines[above])) justified = true;
      above--;
    }
    if (!justified) found.push(`${file}:${index + 1}`);
  });
  return found;
}

describe('$effect guard', () => {
  it('finds the sources it is meant to guard', () => {
    const files = Object.keys(sources);
    expect(files.some((file) => file.endsWith('/App.svelte'))).toBe(true);
    expect(files.some((file) => file.includes('site/src/'))).toBe(true);
  });

  it('flags an effect with no justification, and accepts one with', () => {
    expect(unjustifiedEffects('a', '// keeps x in step\n$effect(() => {});')).toEqual(['a:2']);
    expect(
      unjustifiedEffects('b', '// Effect: a timer, the outside world\n// more\n$effect(() => {});'),
    ).toEqual([]);
    expect(
      unjustifiedEffects('c', '  // onMount rather than $effect: nothing to react to'),
    ).toEqual([]);
  });

  it('every $effect carries a `// Effect:` comment saying why it is one', () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      unjustifiedEffects(file, source),
    );
    expect(offenders).toEqual([]);
  });
});
