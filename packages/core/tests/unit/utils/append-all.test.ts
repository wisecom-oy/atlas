import { describe, it, expect } from 'vitest';
import { append_all } from '@/utils/append-all';

/** Comfortably above V8's spread argument limit (about 125k on Node 22). */
const BEYOND_ARGUMENT_LIMIT = 300_000;

describe('append_all', () => {
  it('appends in order after the existing items', () => {
    const target = [1, 2];
    append_all(target, [3, 4, 5]);
    expect(target).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts any iterable', () => {
    const target: string[] = [];
    append_all(target, new Set(['a', 'b']));
    expect(target).toEqual(['a', 'b']);
  });

  it('appends an array larger than the engine argument limit', () => {
    const items = Array.from({ length: BEYOND_ARGUMENT_LIMIT }, (_, i) => i);
    expect(() => [].push(...(items as never[]))).toThrow(RangeError);

    const target = [-1];
    append_all(target, items);

    expect(target).toHaveLength(BEYOND_ARGUMENT_LIMIT + 1);
    expect(target[BEYOND_ARGUMENT_LIMIT]).toBe(BEYOND_ARGUMENT_LIMIT - 1);
  });
});
