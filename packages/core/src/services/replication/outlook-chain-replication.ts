import type {
  Manifest,
  ManifestRepository,
  ReplicationResult,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { load_older_manifests } from '@/services/shared/manifest-chain';
import {
  owner_scope_results,
  replicate_chains_to_targets,
  snapshot_scope_results,
  type CopyDeps,
} from '@/services/replication/chain-replication-runner';
import {
  rehydrate_snapshot_chain,
  type SnapshotChain,
} from '@/services/replication/rehydration-manifests-runner';
import {
  OUTLOOK_REHYDRATION,
  OUTLOOK_REPLICATION,
  list_mailbox_manifests,
} from '@/services/replication/outlook-manifest-handler';
import { to_status_record } from '@/services/replication/replication-result-builder';

/** What the Outlook chain copies read manifests through and check keys with. */
export interface OutlookChainPorts {
  readonly manifests: ManifestRepository;
  readonly deps: CopyDeps;
}

/**
 * Replicates one Outlook snapshot: its manifest and every older manifest of the mailbox that a
 * target lacks, with their objects (issue #714). A snapshot is its manifest folded with every older
 * one, so copying the named manifest alone left a replica that restores less than the original.
 *
 * @throws UnreadableObjectsError when the chain may need a damaged or missing manifest, before any copy.
 */
export async function replicate_outlook_snapshot_chain(
  ports: OutlookChainPorts,
  source_ctx: TenantContext,
  snapshot_id: string,
  targets: readonly StorageTarget[],
): Promise<ReplicationResult[]> {
  const chain = await load_outlook_chain(ports.manifests, source_ctx, snapshot_id);
  const outcomes = await replicate_chains_to_targets({
    source_ctx,
    targets,
    manifests: chain.manifests,
    plan: OUTLOOK_REPLICATION,
    to_status_record,
    deps: ports.deps,
    target_snapshot_id: chain.target.snapshot_id,
  });
  return snapshot_scope_results(outcomes, chain.target);
}

/** Replicates every snapshot of a mailbox that a target lacks, oldest first. */
export async function replicate_outlook_mailbox_chain(
  ports: OutlookChainPorts,
  source_ctx: TenantContext,
  owner_id: string,
  targets: readonly StorageTarget[],
): Promise<ReplicationResult[]> {
  const manifests = await list_mailbox_manifests(ports.manifests, source_ctx, owner_id);
  const outcomes = await replicate_chains_to_targets({
    source_ctx,
    targets,
    manifests,
    plan: OUTLOOK_REPLICATION,
    to_status_record,
    deps: ports.deps,
  });
  return owner_scope_results(outcomes);
}

/**
 * Recovers one Outlook snapshot from a replica: its manifest and every older manifest of the
 * mailbox that the primary lacks, as the source holds them (issue #714).
 *
 * @throws UnreadableObjectsError when the chain may need a damaged or missing manifest on the source.
 */
export async function rehydrate_outlook_snapshot_chain(
  ports: OutlookChainPorts,
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  snapshot_id: string,
  source: StorageTarget,
): Promise<ReplicationResult> {
  const chain = await load_outlook_chain(ports.manifests, source_ctx, snapshot_id, ' on source');
  return rehydrate_snapshot_chain(
    source_ctx,
    primary_ctx,
    chain,
    source,
    OUTLOOK_REHYDRATION,
    ports.deps,
  );
}

/** Loads a snapshot's chain, naming where it was looked for when the snapshot is absent. */
async function load_outlook_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
  where = '',
): Promise<SnapshotChain<Manifest>> {
  const target = await manifests.find_by_snapshot(ctx, snapshot_id);
  if (!target) throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}${where}`);
  return { target, manifests: [target, ...(await load_older_manifests(manifests, ctx, target))] };
}
