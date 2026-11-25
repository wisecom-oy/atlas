import type { BucketCache } from '@/adapters/bucket-cache';

/**
 * Records that each bucket enforces conditional writes, so a test of a conditional put sees only
 * its own requests and not the probe that would otherwise run first (issue #915).
 */
export async function remember_conditional_writes_enforced(
  cache: BucketCache,
  ...buckets: string[]
): Promise<void> {
  for (const bucket of buckets) {
    await cache.conditional_write_check(bucket, async () => ({
      check: { support: 'supported' },
      provisional: false,
    }));
  }
}
