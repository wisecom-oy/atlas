import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { trim_slashes, trim_trailing_slashes } from '@/services/shared/trim-slashes';
describe('trim_slashes', () => {
  it('removes leading and trailing slashes and keeps the interior', () => {
    expect(trim_slashes('///a/b///')).toBe('a/b');
    expect(trim_slashes('/Projects/2026')).toBe('Projects/2026');
  });

  it('trims an all-slash path to empty', () => {
    expect(trim_slashes('///')).toBe('');
    expect(trim_slashes('')).toBe('');
  });

  it('preserves interior double slashes', () => {
    expect(trim_slashes('/a//b/')).toBe('a//b');
  });
});

describe('trim_trailing_slashes', () => {
  it('removes only trailing slashes', () => {
    expect(trim_trailing_slashes('/a/b//')).toBe('/a/b');
    expect(trim_trailing_slashes('/')).toBe('');
    expect(trim_trailing_slashes('no-slashes')).toBe('no-slashes');
  });
});

/**
 * The regexes these helpers replaced retried the match from every start position, so a 50,000
 * slash run that does not end the string cost about 3.5 s; the scans cost well under a
 * millisecond. A 500 ms budget sits roughly 7x below the quadratic cost and thousands of times
 * above the linear one, so CPU contention from a parallel workspace run cannot close either gap.
 * An earlier version compared timings of two linear inputs, and that ratio was noise-dominated.
 */
const SLASH_RUN = 50_000;
const BUDGET_MS = 500;

/** Fastest of three runs of both helpers, so one preempted run does not decide the result. */
function fastest_elapsed_ms(path: string): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    trim_slashes(path);
    trim_trailing_slashes(path);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('slash trimming scaling', () => {
  it('does not go quadratic on a slash run that does not end the string', () => {
    const path = '/'.repeat(SLASH_RUN) + 'x';

    expect(trim_slashes(path)).toBe('x');
    expect(trim_trailing_slashes(path + '/')).toBe(path);
    expect(fastest_elapsed_ms(path)).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
