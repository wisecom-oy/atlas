import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';
import {
  newest_summaries_first,
  type SnapshotSummaryLayout,
} from '@/services/shared/snapshot-summary-layout';

const ROWLESS_MANIFEST_READ_CONCURRENCY = 8;

/** An owner's snapshots after reconciling the summary rows with the manifest keys in storage. */
export interface ReconciledSnapshotSummaries<T> {
  /** One row per listed manifest that could be read or had a row, newest first. */
  readonly summaries: T[];
  /** Listed manifests that had no row and could not be read. */
  readonly unreadable_keys: string[];
  /** Listed manifests that had no row, each of which was decrypted to build one. */
  readonly rowless_count: number;
}

/**
 * Reconciles recorded summary rows with the manifest keys a listing found (#625).
 *
 * The listing decides which snapshots exist. A key with a row is answered from the row. A key
 * without one, left by a summary write that failed, a rehydrate, or data written before the index
 * existed, is decrypted and summarised. A row whose key is gone, after a delete, quarantine or
 * lifecycle expiry, is dropped. A stale summary therefore costs reads, never a wrong answer.
 */
export async function reconcile_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  manifest_keys: readonly string[],
  recorded: readonly TSummary[],
): Promise<ReconciledSnapshotSummaries<TSummary>> {
  const recorded_by_key = new Map(recorded.map((summary) => [summary.manifest_key, summary]));
  const listed = new Set(manifest_keys);
  const kept = [...listed].flatMap((key) => recorded_by_key.get(key) ?? []);
  const rowless = [...listed].filter((key) => !recorded_by_key.has(key));
  const read = await read_each_readable(
    rowless,
    async (key) => {
      const manifest = await layout.read_manifest(ctx, key);
      return manifest === undefined ? undefined : layout.summarize(manifest, key);
    },
    ROWLESS_MANIFEST_READ_CONCURRENCY,
  );
  return {
    summaries: newest_summaries_first([...kept, ...read.items]),
    unreadable_keys: read.unreadable_keys,
    rowless_count: rowless.length,
  };
}
