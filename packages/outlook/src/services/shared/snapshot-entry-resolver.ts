import type {
  MailboxConnector,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { merge_snapshot_entries } from '@wisecom/atlas-core';
import {
  load_snapshot_chain,
  resolve_message_ref,
} from '@wisecom/atlas-core/services/shared/manifest-chain';
import {
  build_folder_map,
  filter_entries_by_folder_name,
} from '@/services/restore/folder-restore-planner';
import { apply_recoverable_items_policy } from '@/services/restore/recoverable-items-filter';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';

/** Entry filters shared by `restore -s` and `save -s`. */
export interface SnapshotEntryFilter {
  readonly message_ref?: string;
  readonly folder_name?: string;
  readonly include_recoverable_items?: boolean;
}

/** The mailbox a snapshot belongs to and the entries selected from its chain. */
export interface ResolvedSnapshotEntries {
  readonly owner_id: string;
  readonly entries: ManifestEntry[];
}

/**
 * Selects a snapshot's entries from its whole delta chain, newest version per `object_id`, then
 * applies the Recoverable Items policy and the folder or message filter (issue #432).
 */
export async function resolve_snapshot_entries(
  ctx: TenantContext,
  manifests: ManifestRepository,
  connector: MailboxConnector,
  tenant_id: string,
  snapshot_id: string,
  filter: SnapshotEntryFilter,
): Promise<ResolvedSnapshotEntries> {
  const chain = await load_snapshot_chain(manifests, ctx, snapshot_id);
  const target = chain[0]!;
  const merged = merge_snapshot_entries(chain);
  const allowed = apply_recoverable_items_policy(merged, filter.include_recoverable_items);

  if (filter.message_ref) {
    // Resolve before the policy, or `-r 5` would silently mean a different message once anything
    // is filtered out.
    const entry = resolve_message_ref(target, merged, filter.message_ref);
    return { owner_id: target.owner_id, entries: entry && allowed.includes(entry) ? [entry] : [] };
  }

  if (filter.folder_name) {
    await backfill_missing_folder_ids(ctx, allowed);
    const folder_map = await build_folder_map(connector, tenant_id, target.owner_id);
    const entries = filter_entries_by_folder_name(allowed, filter.folder_name, folder_map);
    return { owner_id: target.owner_id, entries };
  }

  return { owner_id: target.owner_id, entries: allowed };
}
