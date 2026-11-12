import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';
import {
  parse_snapshot_summaries,
  serialize_snapshot_summaries,
} from '@/services/shared/snapshot-summary-document';
import type { SnapshotSummaryLayout } from '@/services/shared/snapshot-summary-layout';

/** An owner's stored summary rows and the ETag they were read at, for a conditional rewrite. */
export interface StoredSnapshotSummaries<T> {
  readonly summaries: T[];
  readonly etag: string;
}

/**
 * Reads an owner's summary index; undefined when the object is absent.
 *
 * A summary that fails to decrypt, parse or name this owner reads as having no rows, so the caller
 * decrypts every manifest as it did before the index existed. Its ETag is kept, so the next write
 * replaces it rather than failing a create-only write. A failed fetch raises `StorageError`: an
 * outage must fail the read, not quietly turn every list into a full decrypt.
 */
export async function load_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
): Promise<StoredSnapshotSummaries<TSummary> | undefined> {
  const key = layout.summary_key(owner_id);
  let stored: { data: Buffer; etag: string };
  try {
    stored = await ctx.storage.get_with_etag(key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the ${layout.label} snapshot summary at ${key}`, {
      cause: err,
    });
  }
  return {
    summaries: decode_summaries(ctx, layout, owner_id, key, stored.data),
    etag: stored.etag,
  };
}

/**
 * Encrypts and writes an owner's summary index. `etag` makes the write a compare-and-swap on the
 * object read; without one the write is create-only. Either way a concurrent writer surfaces as a
 * precondition failure (HTTP 412) instead of being overwritten silently.
 */
export async function write_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  summaries: readonly TSummary[],
  etag: string | undefined,
): Promise<void> {
  const key = layout.summary_key(owner_id);
  const body = ctx.encrypt(serialize_snapshot_summaries(owner_id, summaries), key);
  await ctx.storage.put(key, body, undefined, undefined, etag, etag === undefined);
}

/** Decrypts and parses a stored summary, reading anything unusable as no rows. */
function decode_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  key: string,
  payload: Buffer,
): TSummary[] {
  try {
    const value: unknown = JSON.parse(ctx.decrypt(payload, key).toString('utf-8'));
    return parse_snapshot_summaries(layout, owner_id, value) ?? [];
  } catch {
    return [];
  }
}
