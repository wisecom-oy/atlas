import { describe, expect, it } from 'vitest';
import { assert_range_chunk, assert_transferred_size } from '@/backup/download-integrity';

// Issue #338: the checksum is computed over whatever arrived, so a truncated, duplicated or
// restarted transfer produces a validly encrypted object with a matching checksum. The only
// defence is the expectation formed before the transfer.

describe('assert_range_chunk (issue #338)', () => {
  it('rejects a 206 body shorter than the range that was requested', () => {
    expect(() => assert_range_chunk('item-1', 0, 4_194_303, 'bytes 0-0/8388608', 1)).toThrow(
      /returned 1 bytes, expected 4194304/,
    );
  });

  it('rejects a 206 that answered a range other than the one asked for', () => {
    expect(() =>
      assert_range_chunk('item-1', 4_194_304, 8_388_607, 'bytes 0-4194303/8388608', 4_194_304),
    ).toThrow(/was answered with bytes 0-4194303/);
  });

  it('rejects a 206 with no usable Content-Range, so a repeated chunk cannot pass unnoticed', () => {
    expect(() => assert_range_chunk('item-1', 0, 3, null, 4)).toThrow(/without a usable/);
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes */8388608', 4)).toThrow(
      /without a usable/,
    );
  });

  it('accepts the range it asked for', () => {
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/8', 4)).not.toThrow();
  });
});

describe('assert_transferred_size (issue #338)', () => {
  it('accepts a transfer with no reported size to check against', () => {
    expect(() => assert_transferred_size('item-1', 12, 0)).not.toThrow();
  });

  it('rejects a short and an over-long transfer alike', () => {
    expect(() => assert_transferred_size('item-1', 5, 8)).toThrow(/produced 5 bytes, expected 8/);
    expect(() => assert_transferred_size('item-1', 12, 8)).toThrow(/produced 12 bytes, expected 8/);
  });
});
