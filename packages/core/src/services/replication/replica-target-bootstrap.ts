import type { TenantContext } from '@wisecom/atlas-types';
import { is_precondition_failure } from '@/services/shared/precondition-failure';
import { DEK_META_KEY, create_dek_if_absent } from '@/services/replication/conditional-dek-write';

const REPLICA_MARKER_KEY = '_meta/replica.marker';

/**
 * Copies the source DEK blob to a target that has none, create-only.
 *
 * A target that already holds a key is left alone: callers validate that it matches before
 * replicating. A concurrent writer that stores a different key first surfaces as
 * DekWriteConflictError instead of being overwritten (issue #639).
 */
export async function ensure_dek_on_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
): Promise<void> {
  if (await target_ctx.storage.exists(DEK_META_KEY)) return;
  const dek_blob = await source_ctx.storage.get(DEK_META_KEY);
  await create_dek_if_absent(target_ctx.storage, dek_blob, source_ctx.tenant_id);
}

/**
 * Writes the replica marker once, create-only.
 *
 * A marker that a concurrent run created first already says the same thing, so a refused write is
 * treated as success rather than overwriting it.
 */
export async function ensure_replica_marker(
  ctx: TenantContext,
  source_tenant_id: string,
): Promise<void> {
  if (await ctx.storage.exists(REPLICA_MARKER_KEY)) return;
  const marker = { replicated_from_tenant: source_tenant_id, created_at: new Date().toISOString() };
  const data = Buffer.from(JSON.stringify(marker), 'utf-8');
  try {
    await ctx.storage.put(REPLICA_MARKER_KEY, data, undefined, undefined, undefined, true);
  } catch (err) {
    if (!is_precondition_failure(err)) throw err;
  }
}
