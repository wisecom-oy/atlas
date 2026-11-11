import type {
  MailboxConnector,
  Manifest,
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
import {
  apply_recoverable_items_policy,
  folder_listing_for,
} from '@/services/restore/recoverable-items-filter';
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
  /** The snapshot's delta chain, newest first, whose recorded folders name the entries' folders. */
  readonly manifests: readonly Manifest[];
}

/**
 * Selects a snapshot's entries from its whole delta chain, newest version per `object_id`, then
 * applies the folder or message filter (issue #432) and the Recoverable Items policy.
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
  // The policy runs on the selection, so its skip count names only what was asked for (#701).
  const selected = await select_requested_entries(ctx, connector, tenant_id, chain, merged, filter);
  const entries = apply_recoverable_items_policy(selected, filter.include_recoverable_items);
  return { owner_id: target.owner_id, entries, manifests: chain };
}

/**
 * Narrows the merged chain to the message or folder the filter names, or keeps it whole. `chain`
 * is newest first: its head resolves a message index and its recorded folders name the folders.
 */
async function select_requested_entries(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  chain: readonly Manifest[],
  merged: ManifestEntry[],
  filter: SnapshotEntryFilter,
): Promise<ManifestEntry[]> {
  const target = chain[0]!;
  if (filter.message_ref) {
    // Resolved against the unfiltered chain, so `-r 5` names the same message with or without
    // `--include-recoverable-items`.
    const entry = resolve_message_ref(target, merged, filter.message_ref);
    return entry ? [entry] : [];
  }

  if (filter.folder_name) {
    await backfill_missing_folder_ids(ctx, merged);
    const listing = folder_listing_for(merged);
    const folder_map = await build_folder_map(
      connector,
      tenant_id,
      target.owner_id,
      chain,
      listing,
    );
    return filter_entries_by_folder_name(merged, filter.folder_name, folder_map);
  }

  return merged;
}
