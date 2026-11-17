import type {
  LatestReadableManifest,
  ReadableSnapshotSummaries,
  SnapshotSummary,
  TenantContext,
} from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';
import { reconcile_snapshot_summaries } from '@/services/shared/snapshot-summary-reconciler';
import {
  newest_summaries_first,
  type SnapshotSummaryLayout,
} from '@/services/shared/snapshot-summary-layout';
import { load_snapshot_summaries } from '@/services/shared/snapshot-summary-store';
import { append_all } from '@/utils/append-all';
import { logger } from '@/utils/logger';

const OWNER_SUMMARY_READ_CONCURRENCY = 8;

/**
 * Lists one owner's snapshots from its summary index, newest first (#625).
 *
 * Costs one listing of the owner's manifest keys and one summary read, plus a decrypt for each
 * manifest the summary has no row for. Never writes: a reader may run with read-only credentials
 * or against a locked bucket, so the next backup persists any repair.
 */
export async function list_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
): Promise<ReadableSnapshotSummaries<TSummary>> {
  const [manifest_keys, stored] = await Promise.all([
    ctx.storage.list(layout.manifest_prefix(owner_id)),
    load_snapshot_summaries(ctx, layout, owner_id),
  ]);
  return reconcile_owner(ctx, layout, owner_id, manifest_keys, stored?.summaries ?? []);
}

/**
 * Lists every owner's snapshots from their summary indexes, newest first: one listing of the
 * workload's manifest keys, then one summary read per owner.
 */
export async function list_tenant_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
): Promise<ReadableSnapshotSummaries<TSummary>> {
  const keys_by_owner = group_keys_by_owner(
    await ctx.storage.list(layout.manifest_root_prefix),
    layout.manifest_root_prefix,
  );
  const per_owner = await read_each_readable(
    [...keys_by_owner.keys()],
    async (owner_id) => {
      const stored = await load_snapshot_summaries(ctx, layout, owner_id);
      const keys = keys_by_owner.get(owner_id) ?? [];
      return reconcile_owner(ctx, layout, owner_id, keys, stored?.summaries ?? []);
    },
    OWNER_SUMMARY_READ_CONCURRENCY,
  );
  const summaries: TSummary[] = [];
  const unreadable_keys: string[] = [];
  for (const listing of per_owner.items) {
    append_all(summaries, listing.summaries);
    append_all(unreadable_keys, listing.unreadable_keys);
  }
  return { summaries: newest_summaries_first(summaries), unreadable_keys };
}

/**
 * Returns an owner's newest readable manifest, choosing it from the summary index so only that
 * manifest is decrypted. A damaged one is named and the next row tried, so damage newer than the
 * returned manifest is reported as a full scan would report it (issue #631).
 */
export async function find_latest_readable_by_summary<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
): Promise<LatestReadableManifest<TManifest>> {
  const listing = await list_snapshot_summaries(ctx, layout, owner_id);
  const unreadable_keys = [...listing.unreadable_keys];
  for (const summary of listing.summaries) {
    const read = await read_each_readable([summary.manifest_key], (key) =>
      layout.read_manifest(ctx, key),
    );
    const manifest = read.items[0];
    if (manifest !== undefined) return { manifest, unreadable_keys };
    append_all(unreadable_keys, read.unreadable_keys);
  }
  return { manifest: undefined, unreadable_keys };
}

/** Reconciles one owner's rows with its keys and logs how many manifests had to be decrypted. */
async function reconcile_owner<TManifest, TSummary extends SnapshotSummary>(
  ctx: TenantContext,
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  manifest_keys: readonly string[],
  recorded: readonly TSummary[],
): Promise<ReadableSnapshotSummaries<TSummary>> {
  const reconciled = await reconcile_snapshot_summaries(ctx, layout, manifest_keys, recorded);
  if (reconciled.rowless_count > 0) {
    logger.debug(
      `${layout.label} snapshot summary for ${owner_id} lacked ${reconciled.rowless_count} ` +
        `of ${manifest_keys.length} manifest(s); decrypted them instead`,
    );
  }
  return { summaries: reconciled.summaries, unreadable_keys: reconciled.unreadable_keys };
}

/** Groups `{root}{owner}/{name}` keys by owner. */
function group_keys_by_owner(keys: readonly string[], root: string): Map<string, string[]> {
  const by_owner = new Map<string, string[]>();
  for (const key of keys) {
    const owner_id = key.slice(root.length).split('/')[0];
    if (!key.startsWith(root) || !owner_id) continue;
    const owner_keys = by_owner.get(owner_id) ?? [];
    owner_keys.push(key);
    by_owner.set(owner_id, owner_keys);
  }
  return by_owner;
}
