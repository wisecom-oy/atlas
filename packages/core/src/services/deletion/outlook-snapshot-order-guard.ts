import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { assert_snapshot_is_newest } from '@/services/deletion/snapshot-order-guard';

/**
 * Refuses to delete an Outlook snapshot that newer snapshots of the same mailbox build on
 * (issue #704). The rule itself is shared with the drive workloads: see `assert_snapshot_is_newest`.
 */
export async function assert_outlook_snapshot_is_newest(
  manifests: ManifestRepository,
  ctx: TenantContext,
  target: Manifest,
): Promise<void> {
  await assert_snapshot_is_newest(target, () => manifests.list_by_owner(ctx, target.owner_id));
}
