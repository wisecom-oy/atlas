import type {
  ReplicationResult,
  ReplicationWorkload,
  TenantContext,
  TenantContextFactory,
  TenantReplicationResult,
  WorkloadReplicationResult,
} from '@wisecom/atlas-types';
import { merge_replication_results } from '@/services/replication/replication-result-builder';
import { group_manifests_by_scope } from '@/services/replication/manifest-grouping';

/**
 * Runs an outbound replication for every scope (mailbox, OneDrive owner, SharePoint site) that has
 * at least one manifest, and concatenates the per-snapshot results.
 *
 * The scope list is read once and the source context released before fanning out, so a long push
 * does not hold a tenant context open for the whole run.
 */
export async function replicate_every_scope<M>(
  tenant_factory: TenantContextFactory,
  tenant_id: string,
  list_all: (ctx: TenantContext) => Promise<M[]>,
  scope_of: (manifest: M) => string,
  replicate_scope: (scope_id: string) => Promise<ReplicationResult[]>,
): Promise<ReplicationResult[]> {
  const ctx = await tenant_factory.create(tenant_id);
  let scope_ids: string[];
  try {
    scope_ids = [...group_manifests_by_scope(await list_all(ctx), scope_of).keys()];
  } finally {
    ctx.destroy();
  }

  const results: ReplicationResult[] = [];
  for (const scope_id of scope_ids) {
    results.push(...(await replicate_scope(scope_id)));
  }
  return results;
}

/**
 * Recovers every scope present in a grouped manifest set, merging the per-scope results into one.
 *
 * The label reports how many scopes were covered (`3-owners`, `2-sites`), which is what makes an
 * "everything" recovery auditable against the source.
 */
export async function rehydrate_every_scope<M>(
  by_scope: Map<string, M[]>,
  scope_label: string,
  target_id: string,
  rehydrate_scope: (scope_id: string, manifests: M[]) => Promise<ReplicationResult>,
): Promise<ReplicationResult> {
  const results: ReplicationResult[] = [];
  for (const [scope_id, manifests] of by_scope) {
    results.push(await rehydrate_scope(scope_id, manifests));
  }
  return merge_replication_results(results, `${by_scope.size}-${scope_label}`, target_id);
}

/** Assembles per-workload results into a tenant-level result carrying their aggregate. */
export function build_tenant_result(
  workloads: readonly WorkloadReplicationResult[],
  target_id: string,
): TenantReplicationResult {
  return {
    total: merge_replication_results(
      workloads.map((w) => w.result),
      'full-tenant',
      target_id,
    ),
    workloads,
  };
}

/** Labels a workload's per-snapshot results as a single workload-level result. */
export function as_workload_result(
  workload: ReplicationWorkload,
  results: readonly ReplicationResult[],
  target_id: string,
): WorkloadReplicationResult {
  return { workload, result: merge_replication_results(results, workload, target_id) };
}
