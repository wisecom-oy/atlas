import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { filter_manifests_by_date, merge_snapshot_entries } from '@wisecom/atlas-core';
import {
  build_folder_map,
  filter_entries_by_folder_name,
} from '@/services/restore/folder-restore-planner';
import { apply_recoverable_items_policy } from '@/services/restore/recoverable-items-filter';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';

/** Entry filters shared by `restore -m` and `save -m`. */
export interface MailboxEntryFilter {
  readonly folder_name?: string;
  readonly include_recoverable_items?: boolean;
  readonly start_date?: Date;
  readonly end_date?: Date;
}

/** The mailbox's snapshots in the date range, newest first, and the entries selected from them. */
export interface ResolvedMailboxEntries {
  readonly manifests: readonly Manifest[];
  readonly entries: ManifestEntry[];
}

/**
 * Merges every snapshot of a mailbox in the date range, newest version per `object_id`, then
 * applies the Recoverable Items policy and the folder filter. Folders are named from the
 * snapshots' recorded folders first, so a folder deleted since the backup is still selectable.
 */
export async function resolve_mailbox_entries(
  ctx: TenantContext,
  manifests: ManifestRepository,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  filter: MailboxEntryFilter,
): Promise<ResolvedMailboxEntries> {
  const in_range = await load_mailbox_manifests(ctx, manifests, owner_id, filter);
  if (in_range.length === 0) return { manifests: in_range, entries: [] };

  const merged = merge_snapshot_entries(in_range);
  const allowed = apply_recoverable_items_policy(merged, filter.include_recoverable_items);
  if (!filter.folder_name) return { manifests: in_range, entries: allowed };

  await backfill_missing_folder_ids(ctx, allowed);
  const folder_map = await build_folder_map(connector, tenant_id, owner_id, in_range);
  const entries = filter_entries_by_folder_name(allowed, filter.folder_name, folder_map);
  return { manifests: in_range, entries };
}

/** Loads all manifests for a mailbox, sorted newest-first and date-filtered. */
async function load_mailbox_manifests(
  ctx: TenantContext,
  manifests: ManifestRepository,
  owner_id: string,
  filter: MailboxEntryFilter,
): Promise<Manifest[]> {
  const for_mailbox = (await manifests.list_by_owner(ctx, owner_id)).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
  return filter_manifests_by_date(for_mailbox, filter.start_date, filter.end_date);
}
