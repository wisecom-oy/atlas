import {
  drive_manifest_key,
  type DriveReplicationDescriptor,
} from '@/services/replication/drive-replication-descriptor';
import {
  replicate_drive_snapshot_objects,
  type DriveObjectManifest,
} from '@/services/replication/drive-snapshot-replicator';
import type { RehydrationPlan } from '@/services/replication/rehydration-manifests-runner';

/**
 * How a drive workload plugs into the shared rehydration runner: manifests keyed by the
 * descriptor's prefix, copied without a replica marker so recovered data on the primary is not
 * labelled a replica of itself.
 */
export function build_drive_rehydration_plan<
  TManifest extends DriveObjectManifest & { readonly snapshot_id: string },
>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  ancillary_keys: string[],
): RehydrationPlan<TManifest> {
  return {
    manifest_key: (manifest) => drive_manifest_key(descriptor, manifest),
    replicate: (source_ctx, primary_ctx, manifest, manifest_key) =>
      replicate_drive_snapshot_objects(source_ctx, primary_ctx, manifest, manifest_key, {
        skip_marker: true,
        ancillary_keys,
      }),
  };
}
