import { injectable } from 'inversify';
import type {
  StorageConditionalWriteCheck,
  StorageImmutabilityProbeResult,
} from '@wisecom/atlas-types';
import type { ConditionalWriteProbeOutcome } from '@/adapters/s3-conditional-write-probe';

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
  private readonly _conditional_write_probes = new Map<
    string,
    Promise<ConditionalWriteProbeOutcome>
  >();

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

  /**
   * The bucket's conditional-write check, running `probe` only when none is remembered. Callers
   * that arrive while a probe runs share it. A provisional answer is forgotten once it settles,
   * so the next caller probes again (issue #915).
   */
  async conditional_write_check(
    bucket: string,
    probe: () => Promise<ConditionalWriteProbeOutcome>,
  ): Promise<StorageConditionalWriteCheck> {
    let pending = this._conditional_write_probes.get(bucket);
    if (pending === undefined) {
      pending = probe();
      this._conditional_write_probes.set(bucket, pending);
    }
    try {
      const outcome = await pending;
      if (outcome.provisional) this.forget_conditional_write_probe(bucket, pending);
      return outcome.check;
    } catch (err) {
      this.forget_conditional_write_probe(bucket, pending);
      throw err;
    }
  }

  /** Drops everything remembered. Called by `dispose()` and by tests. */
  clear(): void {
    this._checked_buckets.clear();
    this._immutability_probes.clear();
    this._conditional_write_probes.clear();
  }

  /** Forgets `pending` unless a newer probe has already replaced it. */
  private forget_conditional_write_probe(
    bucket: string,
    pending: Promise<ConditionalWriteProbeOutcome>,
  ): void {
    if (this._conditional_write_probes.get(bucket) === pending) {
      this._conditional_write_probes.delete(bucket);
    }
  }
}

/** The requested mode is part of the key: a probe answers one mode's question. */
function probe_key(bucket: string, mode: string | undefined): string {
  return `${bucket}:${mode ?? 'NONE'}`;
}
