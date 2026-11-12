import type { HeldOwnerLease, SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import { is_precondition_failure } from '@/services/shared/precondition-failure';
import { reconcile_snapshot_summaries } from '@/services/shared/snapshot-summary-reconciler';
import type { SnapshotSummaryLayout } from '@/services/shared/snapshot-summary-layout';
import {
  load_snapshot_summaries,
  write_snapshot_summaries,
} from '@/services/shared/snapshot-summary-store';
import { logger } from '@/utils/logger';

/** One write, plus one more after a concurrent writer changed the summary underneath it. */
const MAX_SUMMARY_WRITE_ATTEMPTS = 2;

/**
 * Records a just-saved manifest in its owner's summary index, and logs instead of failing.
 *
 * Runs after the manifest is stored, never before, so a summary never names a snapshot that does
 * not exist. If it fails, the manifest is still the record: readers find its key without a row and
 * decrypt it, and the next backup's write repairs the summary (#625).
 *
 * A lost lease is not a summary failure and is raised: the run must stop before its cursor.
 */
export async function record_snapshot_summary_or_warn<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  summary: TSummary,
  lease?: HeldOwnerLease,
): Promise<void> {
  try {
    await record_snapshot_summary(ctx, layout, owner_id, summary, lease);
  } catch (err) {
    if (err instanceof OwnerLeaseLostError) throw err;
    logger.warn(
      `${layout.label} snapshot summary for ${owner_id} was not updated; lists and status ` +
        `decrypt the manifests it lacks until the next backup rewrites it (${String(err)})`,
    );
  }
}

/**
 * Rewrites an owner's summary index with `summary` added and reconciled against the manifest keys
 * in storage, so the write also seeds rows for older manifests and drops rows of removed ones.
 *
 * The write is conditional on the summary read. When another writer got there first the whole
 * read, reconcile and write runs once more; a second conflict raises. A backend that ignores the
 * condition lets the later write win, which at worst leaves a stale summary that readers repair.
 *
 * `lease`, when the caller holds one, is checked right before each write. Seeding rows decrypts
 * every manifest the summary lacks, which on the first backup after an upgrade can outlast the
 * margin the manifest's own lease check left, and a run that lost its owner to an erasure must not
 * write the summary back under the erased owner's id (issue #623).
 */
export async function record_snapshot_summary<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  summary: TSummary,
  lease?: HeldOwnerLease,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rewrite_with_summary(ctx, layout, owner_id, summary, lease);
      return;
    } catch (err) {
      if (attempt >= MAX_SUMMARY_WRITE_ATTEMPTS || !is_precondition_failure(err)) throw err;
    }
  }
}

/** One read, reconcile, lease check and conditional write of the owner's summary. */
async function rewrite_with_summary<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  summary: TSummary,
  lease: HeldOwnerLease | undefined,
): Promise<void> {
  const [manifest_keys, stored] = await Promise.all([
    ctx.storage.list(layout.manifest_prefix(owner_id)),
    load_snapshot_summaries(ctx, layout, owner_id),
  ]);
  const others = (stored?.summaries ?? []).filter((s) => s.manifest_key !== summary.manifest_key);
  const reconciled = await reconcile_snapshot_summaries(
    ctx,
    layout,
    [...manifest_keys, summary.manifest_key],
    [summary, ...others],
  );
  lease?.assert_held();
  await write_snapshot_summaries(ctx, layout, owner_id, reconciled.summaries, stored?.etag);
}
