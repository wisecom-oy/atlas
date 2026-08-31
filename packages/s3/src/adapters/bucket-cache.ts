import { injectable } from 'inversify';
import type { StorageImmutabilityProbeResult } from '@wisecom/atlas-types';

/**
 * Per-instance memo of what has already been asked of a bucket.
 *
 * Module-level before issue #42, which made it shared by every Atlas instance
 * in the process. Two instances pointing at different S3 endpoints with
 * same-named buckets then answered each other's questions: the second skipped
 * `ensure_bucket_exists` for a bucket that does not exist at its endpoint, and
 * read the first endpoint's Object Lock capability as its own. Bucket names are
 * tenant-scoped, so this only ever bit across endpoints, which is exactly the
 * multi-tenant and disaster-recovery shape the SDK is built for.
 *
 * One cache per container means the hazard cannot recur by construction, and
 * gives `dispose()` something to clear.
 */
@injectable()
export class BucketCache {
  private readonly _checked_buckets = new Set<string>();
  private readonly _immutability_probes = new Map<string, StorageImmutabilityProbeResult>();

  /** Whether this bucket's existence has already been established. */
  is_bucket_checked(bucket: string): boolean {
    return this._checked_buckets.has(bucket);
  }

  /** Records that the bucket exists, so later calls cost nothing. */
  mark_bucket_checked(bucket: string): void {
    this._checked_buckets.add(bucket);
  }

  /** A previous immutability probe for this bucket and requested mode. */
  get_immutability_probe(
    bucket: string,
    mode: string | undefined,
  ): StorageImmutabilityProbeResult | undefined {
    return this._immutability_probes.get(probe_key(bucket, mode));
  }

  /** Memoizes one immutability probe result. */
  set_immutability_probe(
    bucket: string,
    mode: string | undefined,
    result: StorageImmutabilityProbeResult,
  ): void {
    this._immutability_probes.set(probe_key(bucket, mode), result);
  }

  /** Drops everything remembered. Called by `dispose()` and by tests. */
  clear(): void {
    this._checked_buckets.clear();
    this._immutability_probes.clear();
  }
}

/** The requested mode is part of the key: a probe answers one mode's question. */
function probe_key(bucket: string, mode: string | undefined): string {
  return `${bucket}:${mode ?? 'NONE'}`;
}
