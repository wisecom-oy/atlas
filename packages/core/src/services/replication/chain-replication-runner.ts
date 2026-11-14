import type {
  DekValidationFn,
  ReplicationResult,
  ReplicationStatusRecord,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { build_skip_result } from '@/services/replication/replication-result-builder';
import { save_replication_status } from '@/services/replication/replication-status-repository';
import {
  attempted_results,
  copy_missing_chain_links,
  type ChainedManifest,
  type SnapshotChainCopyOutcome,
  type SnapshotChainCopyPlan,
} from '@/services/replication/snapshot-chain-copier';

/** What every copy needs to check that two buckets share the tenant's key. */
export interface CopyDeps {
  readonly validate_dek: DekValidationFn;
  readonly passphrase: string;
  readonly tenant_id: string;
}

/** A replication of snapshot chains from the primary to one or more targets. */
export interface ChainReplicationRequest<TManifest extends ChainedManifest> {
  readonly source_ctx: TenantContext;
  readonly targets: readonly StorageTarget[];
  /** The snapshots to bring to each target, in any order; the copier orders them oldest first. */
  readonly manifests: readonly TManifest[];
  readonly plan: SnapshotChainCopyPlan<TManifest>;
  /** The status record a copied snapshot leaves on the primary. */
  readonly to_status_record: (
    result: ReplicationResult,
    target: StorageTarget,
    manifest: TManifest,
  ) => ReplicationStatusRecord;
  readonly deps: CopyDeps;
}

/** What one target received. */
export interface TargetChainOutcome<TManifest> {
  readonly target: StorageTarget;
  readonly outcome: SnapshotChainCopyOutcome<TManifest>;
}

/**
 * Copies every snapshot each target lacks, recording a status record for each one attempted.
 *
 * Each target's context is opened once, its key is checked once, and the context is destroyed even
 * when the copy throws: `destroy()` is what zeroes the key material it derived (issue #200), and
 * each check is two scrypt unwraps, so it is not repeated per snapshot (issue #206).
 */
export async function replicate_chains_to_targets<TManifest extends ChainedManifest>(
  request: ChainReplicationRequest<TManifest>,
): Promise<TargetChainOutcome<TManifest>[]> {
  const outcomes: TargetChainOutcome<TManifest>[] = [];
  for (const target of request.targets) {
    outcomes.push({ target, outcome: await replicate_chains_to_target(request, target) });
  }
  return outcomes;
}

/** Every attempted snapshot's result across targets, which is what an owner-wide run reports. */
export function owner_scope_results<TManifest>(
  outcomes: readonly TargetChainOutcome<TManifest>[],
): ReplicationResult[] {
  return outcomes.flatMap(({ outcome }) => attempted_results(outcome));
}

/**
 * The results of replicating one snapshot's chain: what each target was sent, or, for a target
 * that already held the whole chain, a skip result counting the snapshot's entries as present.
 */
export function snapshot_scope_results<TManifest extends ChainedManifest>(
  outcomes: readonly TargetChainOutcome<TManifest>[],
  snapshot: TManifest & { readonly entries: readonly unknown[] },
): ReplicationResult[] {
  return outcomes.flatMap(({ target, outcome }) =>
    outcome.attempted.length > 0
      ? attempted_results(outcome)
      : [build_skip_result(snapshot.snapshot_id, target.target_id, snapshot.entries.length)],
  );
}

async function replicate_chains_to_target<TManifest extends ChainedManifest>(
  request: ChainReplicationRequest<TManifest>,
  target: StorageTarget,
): Promise<SnapshotChainCopyOutcome<TManifest>> {
  const { source_ctx, deps } = request;
  const target_ctx = await target.create_context(deps.tenant_id);
  try {
    await deps.validate_dek(
      source_ctx.storage,
      target_ctx.storage,
      deps.passphrase,
      deps.tenant_id,
    );
    return await copy_missing_chain_links(
      source_ctx,
      target_ctx,
      request.manifests,
      request.plan,
      target.target_id,
      ({ manifest, result }) =>
        save_replication_status(source_ctx, request.to_status_record(result, target, manifest)),
    );
  } finally {
    target_ctx.destroy();
  }
}
