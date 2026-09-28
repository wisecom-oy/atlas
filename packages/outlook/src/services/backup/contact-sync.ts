import {
  clear_item_failure,
  describe_failed_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type {
  ContactConnector,
  ContactFolder,
  ContactManifestEntry,
  FailedItemLedger,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  sync_contact_folder,
  type ContactFolderSyncOptions,
} from '@/services/backup/contact-folder-sync';

export interface ContactSyncResult {
  readonly entries: ContactManifestEntry[];
  readonly folders: ContactFolder[];
  readonly delta_links: Record<string, string>;
  readonly failed: FailedItemLedger;
  readonly errors: string[];
  readonly stored: number;
  readonly changed: boolean;
}

export interface ContactSyncOptions extends ContactFolderSyncOptions {
  previous_links?: Record<string, string>;
  previous_folders?: ContactFolder[];
  failed?: FailedItemLedger;
  force_full?: boolean;
}

function folder_inventory_changed(current: ContactFolder[], previous: ContactFolder[]): boolean {
  if (current.length !== previous.length) return true;
  const by_id = new Map(previous.map((folder) => [folder.folder_id, folder]));
  return current.some((folder) => {
    const prior = by_id.get(folder.folder_id);
    return (
      !prior ||
      prior.display_name !== folder.display_name ||
      prior.is_default !== folder.is_default ||
      prior.parent_folder_id !== folder.parent_folder_id
    );
  });
}

/** Captures each contact folder sequentially and commits only completed folder delta links. */
export async function sync_contacts(
  ctx: TenantContext,
  connector: ContactConnector,
  tenant_id: string,
  owner_id: string,
  options: ContactSyncOptions = {},
): Promise<ContactSyncResult> {
  const folders = await connector.list_contact_folders(tenant_id, owner_id);
  const previous_links = options.force_full ? {} : (options.previous_links ?? {});
  const links: Record<string, string> = {};
  const entries: ContactManifestEntry[] = [];
  let failed = options.failed ?? {};
  let stored = 0;
  const folder_ids = new Set(folders.map((folder) => folder.folder_id));
  for (const item of Object.values(failed)) {
    if (!folder_ids.has(item.drive_id)) failed = clear_item_failure(failed, item.item_id);
  }
  for (const folder of folders) {
    if (options.should_interrupt?.()) break;
    const result = await sync_contact_folder({
      ctx,
      connector,
      tenant_id,
      owner_id,
      folder_id: folder.folder_id,
      previous_link: previous_links[folder.folder_id],
      failed,
      should_interrupt: options.should_interrupt,
      object_lock_policy: options.object_lock_policy,
      load_previous_entries: options.load_previous_entries,
    });
    entries.push(...result.entries);
    failed = result.failed;
    stored += result.stored;
    if (result.delta_link) links[folder.folder_id] = result.delta_link;
  }
  const errors = describe_failed_items(failed);
  return {
    entries,
    folders,
    delta_links: links,
    failed,
    errors,
    stored,
    changed:
      entries.length > 0 || folder_inventory_changed(folders, options.previous_folders ?? []),
  };
}
