import type { ReplicationResult, StorageTarget, TenantContext } from '@wisecom/atlas-types';
import {
  load_drive_manifest_chain,
  type DriveManifestLookup,
} from '@/services/shared/drive-manifest-chain-loader';
import {
  owner_scope_results,
  replicate_chains_to_targets,
  snapshot_scope_results,
  type CopyDeps,
  type TargetChainOutcome,
} from '@/services/replication/chain-replication-runner';
import { rehydrate_snapshot_chain } from '@/services/replication/rehydration-manifests-runner';
import {
  build_drive_rehydration_plan,
  build_drive_replication_plan,
} from '@/services/replication/drive-chain-copy-plan';
import {
  collect_drive_ancillary_keys,
  to_drive_status_record,
} from '@/services/replication/drive-replication-result';
import type { DriveReplicationDescriptor } from '@/services/replication/drive-replication-descriptor';
import type { DriveObjectManifest } from '@/services/replication/drive-snapshot-replicator';
import type { ChainedManifest } from '@/services/replication/snapshot-chain-copier';

/** What a drive manifest must carry to be replicated as a link of its owner's chain. */
type DriveChainManifest = DriveObjectManifest &
  ChainedManifest & { readonly total_size_bytes: number };

/** One drive workload's replication wiring: its layout, its manifest reads, and its key check. */
export interface DriveChainPorts<TManifest extends DriveChainManifest> {
  readonly descriptor: DriveReplicationDescriptor<TManifest>;
  readonly lookup: DriveManifestLookup<TManifest>;
  readonly deps: CopyDeps;
}

/**
 * Replicates one drive snapshot: its manifest and every older manifest of the owner or site that a
 * target lacks, with their objects (issue #714). A drive manifest holds one run's delta, so copying
 * the named manifest alone left a replica that restores less than the original.
 *
 * @throws UnreadableObjectsError when the chain needs a damaged manifest, before any copy.
 */
export async function replicate_drive_snapshot_chain<TManifest extends DriveChainManifest>(
  ports: DriveChainPorts<TManifest>,
  source_ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
  targets: readonly StorageTarget[],
): Promise<ReplicationResult[]> {
  const chain = await load_drive_manifest_chain(ports.lookup, source_ctx, owner_id, snapshot_id);
  const outcomes = await replicate_drive_manifests(
    ports,
    source_ctx,
    owner_id,
    chain.manifests,
    targets,
  );
  return snapshot_scope_results(outcomes, chain.target);
}

/** Replicates every listed snapshot of one owner or site that a target lacks, oldest first. */
export async function replicate_drive_owner_chain<TManifest extends DriveChainManifest>(
  ports: DriveChainPorts<TManifest>,
  source_ctx: TenantContext,
  owner_id: string,
  manifests: readonly TManifest[],
  targets: readonly StorageTarget[],
): Promise<ReplicationResult[]> {
  const outcomes = await replicate_drive_manifests(ports, source_ctx, owner_id, manifests, targets);
  return owner_scope_results(outcomes);
}

/**
 * Recovers one drive snapshot from a replica: its manifest and every older manifest of the owner
 * or site that the primary lacks, as the source holds them (issue #714).
 *
 * @throws UnreadableObjectsError when the chain needs a damaged manifest on the source.
 */
export async function rehydrate_drive_snapshot_chain<TManifest extends DriveChainManifest>(
  ports: DriveChainPorts<TManifest>,
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
  source: StorageTarget,
): Promise<ReplicationResult> {
  const chain = await load_drive_manifest_chain(ports.lookup, source_ctx, owner_id, snapshot_id);
  const ancillary = await collect_drive_ancillary_keys(ports.descriptor, source_ctx, owner_id);
  return rehydrate_snapshot_chain(
    source_ctx,
    primary_ctx,
    chain,
    source,
    build_drive_rehydration_plan(ports.descriptor, ancillary),
    ports.deps,
  );
}

/** Copies one owner's manifests to every target, with the owner's version indexes and cursor. */
async function replicate_drive_manifests<TManifest extends DriveChainManifest>(
  ports: DriveChainPorts<TManifest>,
  source_ctx: TenantContext,
  owner_id: string,
  manifests: readonly TManifest[],
  targets: readonly StorageTarget[],
): Promise<TargetChainOutcome<TManifest>[]> {
  const ancillary = await collect_drive_ancillary_keys(ports.descriptor, source_ctx, owner_id);
  return replicate_chains_to_targets({
    source_ctx,
    targets,
    manifests,
    plan: build_drive_replication_plan(ports.descriptor, ancillary),
    to_status_record: (result, target, manifest) =>
      to_drive_status_record(ports.descriptor, result, target, manifest),
    deps: ports.deps,
  });
}
