import { logger } from '@wisecom/atlas-core';
import type { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritesNotEnforcedError } from '@/adapters/conditional-write.errors';
import type { ConditionalWriteProbeOutcome } from '@/adapters/s3-conditional-write-probe';

/**
 * Refuses unless the bucket enforces conditional writes, probing it at most once per process for
 * a verdict (issue #915). Every conditional write passes through here first, so the owner lease,
 * the data key bootstrap, create-only manifests and the identity registry never run unprotected
 * on a backend that ignores the conditions.
 *
 * A probe that could not run lets the write through and logs why: a bucket that does not exist
 * yet, credentials that may not write, or a storage failure is not evidence against the backend.
 * Only the first two can be the backend's final answer, and only a lasting one is remembered.
 *
 * @throws ConditionalWritesNotEnforcedError when the backend broke a conditional-write rule.
 */
export async function require_conditional_writes(
  bucket: string,
  cache: BucketCache,
  probe: () => Promise<ConditionalWriteProbeOutcome>,
): Promise<void> {
  const check = await cache.conditional_write_check(bucket, () =>
    probe().then((outcome) => report_unprobed_bucket(bucket, outcome)),
  );
  if (check.support !== 'ignored') return;
  throw new ConditionalWritesNotEnforcedError(
    bucket,
    check.violations ?? [],
    check.detail ?? 'a conditional write was not enforced',
  );
}

/** Logs a probe that could not run, once per probe rather than once per write. */
function report_unprobed_bucket(
  bucket: string,
  outcome: ConditionalWriteProbeOutcome,
): ConditionalWriteProbeOutcome {
  if (outcome.check.support === 'not_probed') {
    logger.warn(
      `Could not confirm that bucket ${bucket} enforces conditional writes ` +
        `(${outcome.check.detail ?? 'no reason given'}); continuing without that check`,
    );
  }
  return outcome;
}
