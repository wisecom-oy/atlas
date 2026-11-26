import { describe, expect, it } from 'vitest';
import {
  assert_stream_within_part_limit,
  is_listed_size_part_limit_refusal,
  MAX_MULTIPART_PARTS,
  MAX_PART_SIZE_BYTES,
  max_streamed_object_bytes,
  MultipartPartLimitError,
  PartLimitBreach,
  plan_multipart_part_size,
} from '@/services/shared/multipart-part-plan';

// Issue #925: a fixed 8 MiB part size failed every file over 78.1 GiB on part 10,001.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Parts an object of `bytes` takes at `part_size`, as the stream cuts it. */
function parts_for(bytes: number, part_size: number): number {
  return Math.max(1, Math.ceil(bytes / part_size));
}

/** The error a call threw, so its fields can be asserted. */
function thrown_by(call: () => unknown): unknown {
  try {
    call();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('plan_multipart_part_size', () => {
  it.each([
    ['an unknown size', 0],
    ['one byte', 1],
    ['an 8 MiB file', 8 * MIB],
    ['a 64 MiB file at the large-file threshold', 64 * MIB],
  ])('keeps 8 MiB parts for %s', (_label, bytes) => {
    expect(plan_multipart_part_size(bytes)).toBe(8 * MIB);
  });

  it('keeps 8 MiB parts up to exactly 10,000 of them, 78.1 GiB', () => {
    const largest_at_8_mib = MAX_MULTIPART_PARTS * 8 * MIB;

    expect(plan_multipart_part_size(largest_at_8_mib)).toBe(8 * MIB);
    expect(parts_for(largest_at_8_mib, 8 * MIB)).toBe(MAX_MULTIPART_PARTS);
  });

  it('moves to 16 MiB parts one byte past 78.1 GiB, the size that used to fail', () => {
    const bytes = MAX_MULTIPART_PARTS * 8 * MIB + 1;

    expect(plan_multipart_part_size(bytes)).toBe(16 * MIB);
    expect(parts_for(bytes, 16 * MIB)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
  });

  it('plans a 250 GB file (decimal) in 24 MiB parts, fewer than 10,000 of them', () => {
    const bytes = 250 * 1000 ** 3;
    const part_size = plan_multipart_part_size(bytes);

    expect(part_size).toBe(24 * MIB);
    expect(parts_for(bytes, part_size)).toBe(9935);
  });

  it('plans a 250 GiB file (binary) in 32 MiB parts, fewer than 10,000 of them', () => {
    const bytes = 250 * GIB;
    const part_size = plan_multipart_part_size(bytes);

    expect(part_size).toBe(32 * MIB);
    expect(parts_for(bytes, part_size)).toBe(8000);
  });

  it('accepts a file of exactly the largest size, 312.5 GiB', () => {
    expect(max_streamed_object_bytes()).toBe(312.5 * GIB);
    expect(plan_multipart_part_size(max_streamed_object_bytes())).toBe(MAX_PART_SIZE_BYTES);
  });

  it('never plans a part above 32 MiB or more than 10,000 parts for any accepted size', () => {
    for (let bytes = 64 * MIB; bytes <= max_streamed_object_bytes(); bytes += 997 * MIB) {
      const part_size = plan_multipart_part_size(bytes);
      expect(part_size % (8 * MIB)).toBe(0);
      expect(part_size).toBeLessThanOrEqual(MAX_PART_SIZE_BYTES);
      expect(parts_for(bytes, part_size)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
      // The smallest step that fits: one step less would need more than 10,000 parts.
      if (part_size > 8 * MIB) {
        expect(parts_for(bytes, part_size - 8 * MIB)).toBeGreaterThan(MAX_MULTIPART_PARTS);
      }
    }
  });

  it('refuses a file one byte over the largest size, naming the part limit', () => {
    const err = thrown_by(() => plan_multipart_part_size(max_streamed_object_bytes() + 1));

    expect(err).toBeInstanceOf(MultipartPartLimitError);
    expect(err).toMatchObject({
      breach: PartLimitBreach.LISTED_SIZE,
      part_limit: MAX_MULTIPART_PARTS,
      part_size_bytes: MAX_PART_SIZE_BYTES,
    });
    expect((err as Error).message).toContain('at most 10000 parts per multipart upload');
    expect((err as Error).message).toContain('335544320001 bytes');
  });
});

describe('plan_multipart_part_size with a 1,000-part provider limit', () => {
  const PROVIDER_PARTS = 1000;

  it('keeps 8 MiB parts up to 7.8 GiB', () => {
    expect(plan_multipart_part_size(PROVIDER_PARTS * 8 * MIB, PROVIDER_PARTS)).toBe(8 * MIB);
  });

  it('moves to 16 MiB parts for an 8 GiB file', () => {
    const part_size = plan_multipart_part_size(8 * GIB, PROVIDER_PARTS);

    expect(part_size).toBe(16 * MIB);
    expect(parts_for(8 * GIB, part_size)).toBeLessThanOrEqual(PROVIDER_PARTS);
  });

  it('refuses a file past 31.25 GiB, naming the 1,000-part limit', () => {
    expect(max_streamed_object_bytes(PROVIDER_PARTS)).toBe(31.25 * GIB);

    const err = thrown_by(() => plan_multipart_part_size(40 * GIB, PROVIDER_PARTS));

    expect(err).toMatchObject({ breach: PartLimitBreach.LISTED_SIZE, part_limit: 1000 });
    expect((err as Error).message).toContain('at most 1000 parts per multipart upload');
  });
});

describe('assert_stream_within_part_limit', () => {
  it('accepts a stream that fills every part exactly', () => {
    expect(() =>
      assert_stream_within_part_limit(MAX_MULTIPART_PARTS * 8 * MIB, 8 * MIB),
    ).not.toThrow();
  });

  it('stops a stream one byte past what 10,000 parts hold', () => {
    const err = thrown_by(() =>
      assert_stream_within_part_limit(MAX_MULTIPART_PARTS * 8 * MIB + 1, 8 * MIB),
    );

    expect(err).toMatchObject({
      breach: PartLimitBreach.STREAM_OVERFLOW,
      part_limit: MAX_MULTIPART_PARTS,
      part_size_bytes: 8 * MIB,
    });
    expect((err as Error).message).toContain('at most 10000 parts per multipart upload');
  });
});

describe('is_listed_size_part_limit_refusal', () => {
  it('is true only for a refusal by listed size', () => {
    const listed = thrown_by(() => plan_multipart_part_size(max_streamed_object_bytes() + 1));
    const overflow = thrown_by(() => assert_stream_within_part_limit(8 * MIB + 1, 8 * MIB, 1));

    expect(is_listed_size_part_limit_refusal(listed)).toBe(true);
    expect(is_listed_size_part_limit_refusal(overflow)).toBe(false);
    expect(is_listed_size_part_limit_refusal(new Error('File is too large'))).toBe(false);
  });
});
