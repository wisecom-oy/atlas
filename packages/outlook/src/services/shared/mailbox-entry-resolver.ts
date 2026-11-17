import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { filter_manifests_by_date, merge_snapshot_entries } from '@wisecom/atlas-core';
import { filter_entries_by_folder_name } from '@/services/restore/folder-restore-planner';
import { apply_recoverable_items_policy } from '@/services/restore/recoverable-items-filter';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';
import { list_selectable_folders } from '@/services/shared/recorded-folder-catalog';

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
  /**
   * Every snapshot of the mailbox, those in the date range first, each part newest first. An entry
   * can be carried from a snapshot older than the range, and only that snapshot records its folder.
   */
  readonly folder_manifests: readonly Manifest[];
}

/**
 * Merges every snapshot of a mailbox in the date range, newest version per `object_id`, then
 * applies the folder filter and the Recoverable Items policy, in that order so the policy's skip
 * count names only what the filter selected (issue #701). Folders are named from the
 * snapshots' recorded folders first, so a folder deleted since the backup is still selectable
 * and a mailbox Graph no longer serves needs no live listing (issue #713).
 */
export async function resolve_mailbox_entries(
  ctx: TenantContext,
  manifests: ManifestRepository,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  filter: MailboxEntryFilter,
): Promise<ResolvedMailboxEntries> {
  const for_mailbox = await load_mailbox_manifests(ctx, manifests, owner_id);
  const in_range = filter_manifests_by_date(for_mailbox, filter.start_date, filter.end_date);
  const folder_manifests = [...in_range, ...for_mailbox.filter((m) => !in_range.includes(m))];
  if (in_range.length === 0) return { manifests: in_range, entries: [], folder_manifests };

  const merged = merge_snapshot_entries(in_range);
  let selected = merged;
  if (filter.folder_name) {
    await backfill_missing_folder_ids(ctx, merged);
    const source = { connector, tenant_id, owner_id, manifests: folder_manifests };
    const folders = await list_selectable_folders(source, merged, filter.folder_name);
    selected = filter_entries_by_folder_name(merged, filter.folder_name, folders);
  }
  const entries = apply_recoverable_items_policy(selected, filter.include_recoverable_items);
  return { manifests: in_range, entries, folder_manifests };
}

/** Loads all manifests for a mailbox, sorted newest-first. */
async function load_mailbox_manifests(
  ctx: TenantContext,
  manifests: ManifestRepository,
  owner_id: string,
): Promise<Manifest[]> {
  return (await manifests.list_by_owner(ctx, owner_id)).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}
