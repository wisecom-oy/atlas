import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensure_bucket_exists } from '@/adapters/s3-bucket-manager';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

function s3_error(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('s3-bucket-manager lock-capability fallback (issue #640)', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let buckets: BucketCache;

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    buckets = new BucketCache();
  });

  it('rethrows InvalidArgument at creation when it does not name Object Lock', async () => {
    mock_s3.send
      .mockRejectedValueOnce(s3_error('NotFound', ''))
      .mockRejectedValueOnce(s3_error('InvalidArgument', 'Request parameters are not acceptable'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'bad-request', buckets)).rejects.toThrow(
      'Request parameters are not acceptable',
    );
    expect(mock_s3.send).toHaveBeenCalledTimes(2);
  });

  it('rethrows MalformedXML at creation when it does not name Object Lock', async () => {
    mock_s3.send
      .mockRejectedValueOnce(s3_error('NotFound', ''))
      .mockRejectedValueOnce(s3_error('MalformedXML', 'malformed body'));

    await expect(ensure_bucket_exists(mock_s3 as never, 'bad-xml', buckets)).rejects.toThrow(
      'malformed body',
    );
    expect(mock_s3.send).toHaveBeenCalledTimes(2);
  });

  it('falls back to a plain bucket when InvalidArgument names Object Lock', async () => {
    mock_s3.send
      .mockRejectedValueOnce(s3_error('NotFound', ''))
      .mockRejectedValueOnce(
        s3_error('InvalidArgument', 'Object Lock is not supported on this bucket'),
      )
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await ensure_bucket_exists(mock_s3 as never, 'lock-refused', buckets);

    expect(mock_s3.send).toHaveBeenCalledTimes(4);
    expect(mock_s3.send.mock.calls[2][0].input.ObjectLockEnabledForBucket).toBeUndefined();
  });
});
