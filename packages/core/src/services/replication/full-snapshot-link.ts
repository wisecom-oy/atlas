import type {
  ReplicationResult,
  ReplicationStatusRecord,
  StorageTarget,
} from '@wisecom/atlas-types';
import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import {
  full_snapshot_manifest_key,
  type FullSnapshotReplicaManifest,
  type FullSnapshotReplicationDescriptor,
  type FullSnapshotWorkload,
} from '@/services/replication/full-snapshot-replication-descriptor';
import { build_replication_result } from '@/services/replication/replication-result-builder';
import { replicate_snapshot_objects } from '@/services/replication/snapshot-objects-replicator';
import type {
  ChainedManifest,
  SnapshotChainCopyPlan,
} from '@/services/replication/snapshot-chain-copier';

/** One contacts or calendar snapshot as the chain copier sees it: a chain of one manifest. */
export interface FullSnapshotLink extends ChainedManifest {
  readonly workload: FullSnapshotWorkload;
  readonly mailbox_id: string;
  readonly manifest_key: string;
  readonly object_keys: readonly string[];
  readonly total_size_bytes: number;
}

/** Builds the link of a manifest read from the source. */
export function to_full_snapshot_link<TManifest extends FullSnapshotReplicaManifest>(
  descriptor: FullSnapshotReplicationDescriptor<TManifest>,
  manifest: TManifest,
): FullSnapshotLink {
  const mailbox_id = normalize_owner_id(manifest.mailbox_id);
  return {
    workload: descriptor.workload,
    snapshot_id: manifest.snapshot_id,
    created_at: new Date(manifest.created_at),
    mailbox_id,
    manifest_key: full_snapshot_manifest_key(descriptor, mailbox_id, manifest.snapshot_id),
    object_keys: descriptor.object_keys(manifest),
    total_size_bytes: manifest.total_size_bytes,
  };
}

/**
 * How a contacts or calendar snapshot plugs into the chain copier when copying to a replica.
 *
 * Every snapshot lists every item, so no snapshot builds on another. Each one is its own chain,
 * keyed by its manifest: a failed snapshot leaves no newer one of the mailbox out, and a rerun
 * retries only the snapshots whose manifest the destination still lacks.
 */
export const FULL_SNAPSHOT_REPLICATION: SnapshotChainCopyPlan<FullSnapshotLink> = {
  manifest_key: (link) => link.manifest_key,
  owner_of: (link) => link.manifest_key,
  copy: (source_ctx, target_ctx, link, manifest_key) =>
    replicate_snapshot_objects(source_ctx, target_ctx, link.object_keys, manifest_key),
};

/** The same copy back to the primary, without a replica marker. */
export const FULL_SNAPSHOT_REHYDRATION: SnapshotChainCopyPlan<FullSnapshotLink> = {
  ...FULL_SNAPSHOT_REPLICATION,
  copy: (source_ctx, primary_ctx, link, manifest_key) =>
    replicate_snapshot_objects(source_ctx, primary_ctx, link.object_keys, manifest_key, {
      skip_marker: true,
    }),
};

/** The status record a replicated contacts or calendar snapshot leaves on the primary. */
export function to_full_snapshot_status_record(
  result: ReplicationResult,
  target: StorageTarget,
  link: FullSnapshotLink,
): ReplicationStatusRecord {
  const last_error = result.errors.at(-1);
  return {
    target_id: target.target_id,
    target_endpoint: target.endpoint,
    snapshot_id: link.snapshot_id,
    owner_id: link.mailbox_id,
    status: result.status,
    started_at: new Date(Date.now() - result.elapsed_ms).toISOString(),
    completed_at: new Date().toISOString(),
    objects_total: result.objects_total,
    objects_copied: result.objects_copied,
    objects_skipped: result.objects_skipped,
    objects_failed: result.objects_failed,
    bytes_total: link.total_size_bytes,
    bytes_copied: result.bytes_copied,
    ...(last_error !== undefined ? { last_error } : {}),
    verification_status: result.verification_status,
    source_manifest_checksum: result.source_manifest_checksum ?? '',
    replicated_manifest_checksum: result.replicated_manifest_checksum ?? '',
  };
}

/**
 * A failed result for a manifest the source holds but cannot read. Its objects are unknown, so
 * nothing of the snapshot is copied, and the failure is reported rather than skipped silently.
 */
export function unreadable_manifest_result(
  manifest_key: string,
  dest_id: string,
  reason: string,
): ReplicationResult {
  const file_name = manifest_key.slice(manifest_key.lastIndexOf('/') + 1);
  const snapshot_id = file_name.replace(/\.json$/, '');
  return build_replication_result(
    {
      objects_copied: 0,
      objects_skipped: 0,
      objects_failed: 1,
      bytes_copied: 0,
      errors: [`${manifest_key}: manifest is unreadable on the source, not copied: ${reason}`],
    },
    snapshot_id,
    dest_id,
    0,
  );
}
