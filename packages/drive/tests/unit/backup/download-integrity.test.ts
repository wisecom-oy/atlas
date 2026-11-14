import { describe, expect, it } from 'vitest';
import {
  assert_range_chunk,
  assert_transferred_size,
  DownloadIntegrityError,
} from '@/backup/download-integrity';

// Issue #338: the checksum is computed over whatever arrived, so a truncated, duplicated or
// restarted transfer produces a validly encrypted object with a matching checksum. The only
// defence is the expectation formed before the transfer.

describe('assert_range_chunk (issue #338)', () => {
  it('rejects a 206 body shorter than the range that was requested', () => {
    expect(() =>
      assert_range_chunk('item-1', 0, 4_194_303, 'bytes 0-0/8388608', 1, 8_388_608),
    ).toThrow(/returned 1 bytes, expected 4194304/);
  });

  it('rejects a 206 that answered a range other than the one asked for', () => {
    expect(() =>
      assert_range_chunk(
        'item-1',
        4_194_304,
        8_388_607,
        'bytes 0-4194303/8388608',
        4_194_304,
        8_388_608,
      ),
    ).toThrow(/was answered with bytes 0-4194303/);
  });

  it('rejects a 206 with no usable Content-Range, so a repeated chunk cannot pass unnoticed', () => {
    expect(() => assert_range_chunk('item-1', 0, 3, null, 4, 8)).toThrow(/without a usable/);
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes */8', 4, 8)).toThrow(/without a usable/);
  });

  it('accepts the range it asked for', () => {
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/8', 4, 8)).not.toThrow();
  });
});

describe('assert_range_chunk total check (issue #721)', () => {
  // The ranges were cut from the 8 byte size the delta listing reported. A file that grew or
  // shrank before the download still answers each range with the right bytes, so the total is
  // the only field that shows the rest of the transfer would be stitched from a different file.

  it('rejects a 206 whose total is larger than the planned size, as a file that grew would be', () => {
    const attempt = (): void => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/12', 4, 8);
    expect(attempt).toThrow(DownloadIntegrityError);
    expect(attempt).toThrow(/came from a 12 byte file, but the transfer was planned for 8 bytes/);
  });

  it('rejects a 206 whose total is smaller than the planned size', () => {
    const attempt = (): void => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/4', 4, 8);
    expect(attempt).toThrow(DownloadIntegrityError);
    expect(attempt).toThrow(/came from a 4 byte file, but the transfer was planned for 8 bytes/);
  });

  it('accepts a 206 whose total matches the planned size', () => {
    expect(() => assert_range_chunk('item-1', 4, 7, 'bytes 4-7/8', 4, 8)).not.toThrow();
  });

  it('keeps accepting a total of * as before, since it reports no size', () => {
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/*', 4, 8)).not.toThrow();
    expect(() => assert_range_chunk('item-1', 0, 3, 'bytes 0-3/*', 4, 12)).not.toThrow();
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
