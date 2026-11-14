import {
  drive_manifest_key,
  type DriveReplicationDescriptor,
} from '@/services/replication/drive-replication-descriptor';
import {
  replicate_drive_snapshot_objects,
  type DriveObjectManifest,
} from '@/services/replication/drive-snapshot-replicator';
import type {
  ChainedManifest,
  SnapshotChainCopyPlan,
} from '@/services/replication/snapshot-chain-copier';

type DriveChainManifest = DriveObjectManifest & ChainedManifest;

/**
 * How a drive workload plugs into the chain copier when copying to a replica: manifests keyed by
 * the descriptor's prefix, each copied with the owner's version indexes and delta cursor.
 */
export function build_drive_replication_plan<TManifest extends DriveChainManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  ancillary_keys: string[],
): SnapshotChainCopyPlan<TManifest> {
  return {
    manifest_key: (manifest) => drive_manifest_key(descriptor, manifest),
    owner_of: descriptor.owner_id_of,
    copy: (source_ctx, target_ctx, manifest, manifest_key) =>
      replicate_drive_snapshot_objects(source_ctx, target_ctx, manifest, manifest_key, {
        ancillary_keys,
      }),
  };
}

/**
 * How a drive workload plugs into the chain copier when recovering to the primary: the same copy
 * without a replica marker, so recovered data on the primary is not labelled a replica of itself.
 */
export function build_drive_rehydration_plan<TManifest extends DriveChainManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  ancillary_keys: string[],
): SnapshotChainCopyPlan<TManifest> {
  return {
    ...build_drive_replication_plan(descriptor, ancillary_keys),
    copy: (source_ctx, primary_ctx, manifest, manifest_key) =>
      replicate_drive_snapshot_objects(source_ctx, primary_ctx, manifest, manifest_key, {
        skip_marker: true,
        ancillary_keys,
      }),
  };
}
