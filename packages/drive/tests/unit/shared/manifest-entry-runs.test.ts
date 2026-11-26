import { describe, expect, it } from 'vitest';
import { split_entries_by_size } from '@/shared/manifest-entry-runs';

describe('split_entries_by_size', () => {
  it('yields consecutive runs within the byte budget, in order', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}` }));
    const runs = [...split_entries_by_size(entries, 40)];

    expect(runs.flatMap((run) => run.entry_texts)).toEqual(entries.map((e) => JSON.stringify(e)));
    expect(runs.every((run) => run.byte_length <= 40)).toBe(true);
    expect(runs.length).toBeGreaterThan(1);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const [run] = [...split_entries_by_size([{ n: 'ä' }], 100)];

    expect(run?.byte_length).toBe(Buffer.byteLength('{"n":"ä"}') + 1);
  });

  it('serialises lazily, one run at a time', () => {
    let reads = 0;
    const entries = Array.from({ length: 6 }, (_, i) => ({
      toJSON: () => {
        reads++;
        return { i };
      },
    }));
    const runs = split_entries_by_size(entries, 16);

    runs.next();
    expect(reads).toBeLessThan(entries.length);
  });

  it('yields nothing for no entries', () => {
    expect([...split_entries_by_size([], 10)]).toEqual([]);
  });
});
