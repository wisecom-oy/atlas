import type { ReplicationResult, StorageTarget, TenantContext } from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';
import {
  owner_scope_results,
  replicate_chains_to_targets,
  type CopyDeps,
} from '@/services/replication/chain-replication-runner';
import {
  FULL_SNAPSHOT_REHYDRATION,
  FULL_SNAPSHOT_REPLICATION,
  to_full_snapshot_link,
  to_full_snapshot_status_record,
  unreadable_manifest_result,
  type FullSnapshotLink,
} from '@/services/replication/full-snapshot-link';
import type {
  FullSnapshotReplicaManifest,
  FullSnapshotReplicationDescriptor,
} from '@/services/replication/full-snapshot-replication-descriptor';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import { merge_replication_results } from '@/services/replication/replication-result-builder';

/** Manifest reads in flight at once while listing a mailbox or a whole tenant. */
const MANIFEST_READ_CONCURRENCY = 8;

/** A manifest the bucket holds but that failed to decrypt, parse or identify as its key. */
export interface UnreadableManifest {
  readonly key: string;
  readonly reason: string;
}

/** The contacts or calendar snapshots one bucket holds under a prefix. */
export interface FullSnapshotListing {
  readonly links: readonly FullSnapshotLink[];
  readonly unreadable: readonly UnreadableManifest[];
}

/**
 * Reads every manifest under `prefix` of a workload. A damaged manifest is named in `unreadable`
 * and the listing goes on, since no other snapshot depends on it; a storage error fails the call.
 */
export async function list_full_snapshots<TManifest extends FullSnapshotReplicaManifest>(
  descriptor: FullSnapshotReplicationDescriptor<TManifest>,
  ctx: TenantContext,
  prefix: string,
): Promise<FullSnapshotListing> {
  const keys = (await ctx.storage.list(prefix)).filter((key) => key.endsWith('.json'));
  const listing = await read_each_readable(
    keys,
    (key) => descriptor.read_manifest_at(ctx, key),
    MANIFEST_READ_CONCURRENCY,
  );
  return {
    links: listing.items.map((manifest) => to_full_snapshot_link(descriptor, manifest)),
    unreadable: listing.unreadable_keys.map((key, index) => ({
      key,
      reason: listing.unreadable_errors[index]?.message ?? 'unreadable',
    })),
  };
}

/**
 * Copies every listed snapshot each target lacks, recording a status record for each attempt.
 * Returns one result per attempted snapshot and target, plus a failed result per target for each
 * unreadable manifest. An empty listing opens no target and returns nothing.
 */
export async function replicate_full_snapshots(
  source_ctx: TenantContext,
  listing: FullSnapshotListing,
  targets: readonly StorageTarget[],
  deps: CopyDeps,
): Promise<ReplicationResult[]> {
  const copied =
    listing.links.length === 0
      ? []
      : owner_scope_results(
          await replicate_chains_to_targets({
            source_ctx,
            targets,
            manifests: listing.links,
            plan: FULL_SNAPSHOT_REPLICATION,
            to_status_record: to_full_snapshot_status_record,
            deps,
          }),
        );
  const unreadable = targets.flatMap((target) =>
    listing.unreadable.map(({ key, reason }) =>
      unreadable_manifest_result(key, target.target_id, reason),
    ),
  );
  return [...copied, ...unreadable];
}

/**
 * Copies every listed snapshot the primary lacks back from a replica, reported as one result.
 * Each unreadable manifest on the replica counts as one failed object, so the run is not complete.
 */
export async function rehydrate_full_snapshots(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  listing: FullSnapshotListing,
  source: StorageTarget,
  deps: CopyDeps,
): Promise<ReplicationResult> {
  const copied = await rehydrate_manifests(
    source_ctx,
    primary_ctx,
    [...listing.links],
    source,
    deps.tenant_id,
    deps.validate_dek,
    deps.passphrase,
    FULL_SNAPSHOT_REHYDRATION,
  );
  if (listing.unreadable.length === 0) return copied;
  const unreadable = listing.unreadable.map(({ key, reason }) =>
    unreadable_manifest_result(key, source.target_id, reason),
  );
  return merge_replication_results([copied, ...unreadable], copied.snapshot_id, source.target_id);
}
