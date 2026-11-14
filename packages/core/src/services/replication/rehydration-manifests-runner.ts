import type { TenantContext } from '@wisecom/atlas-types';
import type { StorageTarget, DekValidationFn } from '@wisecom/atlas-types';
import type { CopyDeps } from '@/services/replication/chain-replication-runner';
import type { ReplicationResult } from '@wisecom/atlas-types';
import {
  build_replication_result,
  build_skip_result,
  merge_replication_results,
} from '@/services/replication/replication-result-builder';
import {
  attempted_results,
  copy_missing_chain_links,
  type ChainedManifest,
  type SnapshotChainCopyPlan,
} from '@/services/replication/snapshot-chain-copier';

/** A snapshot's manifest and its chain: the target first, then every older manifest. */
export interface SnapshotChain<TManifest> {
  readonly target: TManifest;
  readonly manifests: readonly TManifest[];
}

type Entries = { readonly entries: readonly unknown[] };

/**
 * What a workload contributes to rehydration: where its manifest lives on the primary, whose chain
 * it belongs to, and how to copy one snapshot back without writing a replica marker. Outlook,
 * OneDrive and SharePoint differ in nothing else here.
 */
export type RehydrationPlan<TManifest extends ChainedManifest> = SnapshotChainCopyPlan<TManifest>;

/**
 * Rehydrates multiple manifests from a source target back to the primary, oldest first, skipping
 * manifests that already exist on the primary and stopping an owner's chain at its first failure.
 */
export async function rehydrate_manifests<TManifest extends ChainedManifest>(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  manifests: TManifest[],
  source: StorageTarget,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
  plan: RehydrationPlan<TManifest>,
): Promise<ReplicationResult> {
  const start = Date.now();
  await validate_dek(source_ctx.storage, primary_ctx.storage, passphrase, tenant_id);
  const outcome = await copy_missing_chain_links(
    source_ctx,
    primary_ctx,
    manifests,
    plan,
    source.target_id,
  );

  const copied = merge_replication_results(attempted_results(outcome), '', source.target_id);
  const snapshot_label =
    manifests.length === 1 ? manifests[0]!.snapshot_id : `${outcome.attempted.length}-snapshots`;

  return build_replication_result(
    {
      ...copied,
      // A snapshot already on the primary counts as one skipped object, as it always has.
      objects_skipped: copied.objects_skipped + outcome.present.length,
    },
    snapshot_label,
    source.target_id,
    Date.now() - start,
  );
}

/**
 * Rehydrates one snapshot: its manifest and every older manifest of its owner that the primary
 * lacks, oldest first (issue #714). `chain` is the snapshot's chain as read on the source, target
 * first. A chain the primary already holds whole is reported as skipped with the target's entries.
 */
export async function rehydrate_snapshot_chain<TManifest extends ChainedManifest & Entries>(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  chain: SnapshotChain<TManifest>,
  source: StorageTarget,
  plan: RehydrationPlan<TManifest>,
  deps: CopyDeps,
): Promise<ReplicationResult> {
  const start = Date.now();
  await deps.validate_dek(source_ctx.storage, primary_ctx.storage, deps.passphrase, deps.tenant_id);
  const outcome = await copy_missing_chain_links(
    source_ctx,
    primary_ctx,
    chain.manifests,
    plan,
    source.target_id,
  );
  if (outcome.attempted.length === 0) {
    return build_skip_result(
      chain.target.snapshot_id,
      source.target_id,
      chain.target.entries.length,
    );
  }
  const merged = merge_replication_results(
    attempted_results(outcome),
    chain.target.snapshot_id,
    source.target_id,
  );
  return { ...merged, elapsed_ms: Date.now() - start };
}
