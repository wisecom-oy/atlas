import type { HeldOwnerLease, SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import type { SnapshotSummaryLayout } from '@/services/shared/snapshot-summary-layout';
import {
  load_snapshot_summaries,
  write_snapshot_summaries,
} from '@/services/shared/snapshot-summary-store';
import { logger } from '@/utils/logger';

/**
 * Drops the row of a manifest that a snapshot delete or a quarantine has just removed from its
 * owner's summary index, and logs instead of failing.
 *
 * Runs only after the manifest is gone. Readers already drop a row whose manifest no listing
 * finds, so a failure here costs nothing but the stale row until the next backup's rewrite; the
 * prune keeps a removed snapshot's ID, date and counts from lingering in the object meanwhile.
 *
 * A lost lease is not a summary failure and is raised: the run no longer owns the owner (#623).
 */
export async function forget_snapshot_summary_or_warn<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  snapshot_id: string,
  lease?: HeldOwnerLease,
): Promise<void> {
  try {
    await forget_snapshot_summary(ctx, layout, owner_id, snapshot_id, lease);
  } catch (err) {
    if (err instanceof OwnerLeaseLostError) throw err;
    logger.warn(
      `${layout.label} snapshot summary for ${owner_id} still lists removed snapshot ` +
        `${snapshot_id}; reads skip it, and the next backup rewrites the summary (${String(err)})`,
    );
  }
}

/**
 * Drops the rows of several removed snapshots in one summary rewrite, and logs instead of failing,
 * as {@link forget_snapshot_summary_or_warn} does for one. A prune removes many snapshots at once,
 * and one rewrite per snapshot would rewrite the whole summary that many times.
 */
export async function forget_snapshot_summaries_or_warn<
  TManifest,
  TSummary extends SnapshotSummary,
>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  snapshot_ids: readonly string[],
  lease?: HeldOwnerLease,
): Promise<void> {
  if (snapshot_ids.length === 0) return;
  try {
    await forget_snapshot_rows(ctx, layout, owner_id, snapshot_ids, lease);
  } catch (err) {
    if (err instanceof OwnerLeaseLostError) throw err;
    logger.warn(
      `${layout.label} snapshot summary for ${owner_id} still lists ${snapshot_ids.length} removed ` +
        `snapshot(s); reads skip them, and the next backup rewrites the summary (${String(err)})`,
    );
  }
}

/**
 * Rewrites the owner's summary without the snapshot's row, as a compare-and-swap on the summary
 * read. Writes nothing when there is no summary or it has no such row, so it never creates one.
 * `lease`, when the caller holds one, is checked right before the summary write.
 */
export async function forget_snapshot_summary<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  snapshot_id: string,
  lease?: HeldOwnerLease,
): Promise<void> {
  await forget_snapshot_rows(ctx, layout, owner_id, [snapshot_id], lease);
}

/** Rewrites the summary without the rows of these snapshots; writes nothing when it has none. */
async function forget_snapshot_rows<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  snapshot_ids: readonly string[],
  lease: HeldOwnerLease | undefined,
): Promise<void> {
  const manifest_keys = new Set(snapshot_ids.map((id) => layout.manifest_key(owner_id, id)));
  const stored = await load_snapshot_summaries(ctx, layout, owner_id);
  if (!stored?.summaries.some((summary) => manifest_keys.has(summary.manifest_key))) return;
  const remaining = stored.summaries.filter((summary) => !manifest_keys.has(summary.manifest_key));
  lease?.assert_held();
  await write_snapshot_summaries(ctx, layout, owner_id, remaining, stored.etag);
}
