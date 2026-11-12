import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@/services/shared/absent-object';
import {
  build_snapshot_summary_document,
  parse_snapshot_summaries,
  require_snapshot_summary_document,
} from '@/services/shared/snapshot-summary-document';
import type { SnapshotSummaryLayout } from '@/services/shared/snapshot-summary-layout';
import { write_encrypted_json } from '@/services/shared/stored-json-writer';

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
 * Writes an owner's summary index through the guarded writer. `etag` makes the write a
 * compare-and-swap on the object read; without one it writes only onto an absent key. Either way a
 * concurrent writer surfaces as a precondition failure (HTTP 412) instead of being overwritten
 * silently.
 *
 * The body is refused before upload when the reader would treat it as absent. It is not read
 * back: every reader reconciles the rows with a listing of the manifests and treats a summary that
 * is absent, damaged or foreign as empty, so nothing trusts the object without that fallback.
 */
export async function write_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  summaries: readonly TSummary[],
  etag: string | undefined,
): Promise<void> {
  await write_encrypted_json(
    ctx,
    {
      key: layout.summary_key(owner_id),
      label: `${layout.label} snapshot summary`,
      reader_check: (parsed) => require_snapshot_summary_document(owner_id, parsed),
      write: 'overwrite',
      expected_etag: etag ?? null,
      confirm_read_back: false,
    },
    build_snapshot_summary_document(owner_id, summaries),
  );
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
