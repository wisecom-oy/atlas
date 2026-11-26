import { describe, expect, it } from 'vitest';
import {
  bucket_of,
  build_bucket_item_maps,
  choose_bucket_count,
  count_tracked_items,
  index_item_ids_by_bucket,
  split_cursor_fields,
} from '@/shared/cursor-item-buckets';

describe('choose_bucket_count', () => {
  it('picks the smallest power of two that keeps buckets at the target', () => {
    expect(choose_bucket_count(1, 2048)).toBe(1);
    expect(choose_bucket_count(10_001, 2048)).toBe(8);
    expect(choose_bucket_count(2_000_000, 2048)).toBe(1024);
  });

  it('keeps the previous count while buckets stay between a quarter and twice the target', () => {
    expect(choose_bucket_count(10_001, 2048, 16)).toBe(16);
    expect(choose_bucket_count(65_000, 2048, 16)).toBe(16);
    expect(choose_bucket_count(66_000, 2048, 16)).toBe(64);
    expect(choose_bucket_count(8_000, 2048, 16)).toBe(4);
  });

  it('ignores a previous count that is not a power of two', () => {
    expect(choose_bucket_count(10_001, 2048, 12)).toBe(8);
  });
});

describe('bucket_of', () => {
  it('is stable and within range', () => {
    for (const count of [1, 2, 64, 1024]) {
      const bucket = bucket_of('01ABCDEFGHIJKLMNOPQRSTUVWXYZ', count);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(count);
      expect(bucket_of('01ABCDEFGHIJKLMNOPQRSTUVWXYZ', count)).toBe(bucket);
    }
  });

  it('spreads ids roughly evenly', () => {
    const counts = new Array<number>(16).fill(0);
    for (let i = 0; i < 16_000; i++) counts[bucket_of(`item-${i}`, 16)]!++;
    expect(Math.min(...counts)).toBeGreaterThan(800);
    expect(Math.max(...counts)).toBeLessThan(1200);
  });
});

describe('split_cursor_fields', () => {
  it('moves only the item maps out of the head, and leaves an absent map absent', () => {
    const split = split_cursor_fields({
      owner_id: 'o',
      delta_link_by_drive: { d: 'link' },
      previous_path_by_file_id: { a: '/a' },
      failed_items: {},
      updated_at: 't',
    });

    expect(split.head_fields).toEqual({
      owner_id: 'o',
      delta_link_by_drive: { d: 'link' },
      updated_at: 't',
    });
    expect(split.item_maps).toEqual({ previous_path_by_file_id: { a: '/a' }, failed_items: {} });
    expect(count_tracked_items(split.item_maps)).toBe(1);
  });
});

describe('build_bucket_item_maps', () => {
  it('builds the same bucket text whatever order the items were inserted in', () => {
    const forward = { previous_name_by_file_id: { a: '1', b: '2', c: '3', d: '4' } };
    const backward = { previous_name_by_file_id: { d: '4', c: '3', b: '2', a: '1' } };
    const text = (maps: typeof forward): string[] => {
      const ids = index_item_ids_by_bucket(maps, 2);
      return [0, 1].map((bucket) => JSON.stringify(build_bucket_item_maps(maps, ids, bucket)));
    };

    expect(text(backward)).toEqual(text(forward));
  });
});
