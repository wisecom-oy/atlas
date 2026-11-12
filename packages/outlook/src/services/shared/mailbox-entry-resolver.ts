import type {
  MailboxConnector,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { ConfigError } from '@wisecom/atlas-types';
import { filter_manifests_by_date, merge_snapshot_entries } from '@wisecom/atlas-core';
import {
  build_folder_map,
  filter_entries_by_folder_name,
} from '@/services/restore/folder-restore-planner';
import {
  apply_recoverable_items_policy,
  folder_listing_for,
} from '@/services/restore/recoverable-items-filter';
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
 * Refuses a message reference in mailbox mode, before any storage read or Graph call.
 *
 * A message number indexes one snapshot's listing, and mailbox mode merges many snapshots, so the
 * reference has nothing to resolve against. It used to be accepted and dropped, which widened a
 * one-message restore or save to the whole mailbox (issue #705). Any supplied value is refused,
 * the empty string included, because an empty reference widens to the mailbox just the same.
 */
export function refuse_message_ref_in_mailbox_mode(message_ref: string | undefined): void {
  if (message_ref === undefined) return;
  throw new ConfigError(
    'messageRef selects a message inside one snapshot, so it is not accepted for a whole ' +
      'mailbox. Restore or save that message from its snapshot instead.',
  );
}

/**
 * Merges every snapshot of a mailbox in the date range, newest version per `object_id`, then
 * applies the folder filter and the Recoverable Items policy, in that order so the policy's skip
 * count names only what the filter selected (issue #701). Folders are named from the
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
  let selected = merged;
  if (filter.folder_name) {
    await backfill_missing_folder_ids(ctx, merged);
    const listing = folder_listing_for(merged);
    const folder_map = await build_folder_map(connector, tenant_id, owner_id, in_range, listing);
    selected = filter_entries_by_folder_name(merged, filter.folder_name, folder_map);
  }
  const entries = apply_recoverable_items_policy(selected, filter.include_recoverable_items);
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
