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
 * Quadratic scanning on a 10x larger input costs about 100x, linear about 10x. The 40x bound
 * leaves room for scheduler noise while still failing on the polynomial-redos shape that made
 * the regex versions quadratic.
 */
function elapsed_ms(path: string): number {
  const start = performance.now();
  trim_slashes(path);
  trim_trailing_slashes(path);
  return performance.now() - start;
}

describe('slash trimming scaling', () => {
  it('does not go quadratic on a slash run that does not end the string', () => {
    const small = '/'.repeat(20_000) + 'x';
    const large = '/'.repeat(200_000) + 'x';

    expect(trim_slashes(small)).toBe('x');
    expect(trim_trailing_slashes(small + '/')).toBe(small);

    const small_ms = Math.min(elapsed_ms(small), elapsed_ms(small));
    const large_ms = Math.min(elapsed_ms(large), elapsed_ms(large));
    expect(large_ms).toBeGreaterThanOrEqual(0);
    expect(large_ms / Math.max(small_ms, 0.01)).toBeLessThan(40);
  }, 30_000);
});
