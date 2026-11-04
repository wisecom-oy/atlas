import type {
  ContactManifestEntry,
  ContactsConnector,
  GraphContactFolder,
  TenantContext,
} from '@wisecom/atlas-types';
import { store_contact_entry } from '@/services/backup/backup-contact-store';

/** Shared inputs for syncing every folder of one mailbox in one run. */
export interface FolderSyncDeps {
  readonly ctx: TenantContext;
  readonly connector: ContactsConnector;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly should_interrupt: () => boolean;
}

/** A folder synced to its final state, or one left partway when the run was interrupted. */
export type FolderSyncResult =
  | {
      readonly complete: true;
      readonly entries: readonly ContactManifestEntry[];
      readonly delta_link: string;
      readonly objects_stored: number;
    }
  | { readonly complete: false; readonly objects_stored: number };

/**
 * Applies one folder's delta over `base` (the previous snapshot's entries for that folder).
 * A full read (no link, or a reset) replaces the base with the folder's current contents.
 */
export async function sync_folder(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  base: readonly ContactManifestEntry[],
  delta_link: string | undefined,
): Promise<FolderSyncResult> {
  const delta = await deps.connector.fetch_contact_delta(
    deps.tenant_id,
    deps.mailbox_id,
    folder.id,
    delta_link,
  );
  // A full read (no link, or a reset) returns every current contact, so stale base entries must go.
  const start: readonly ContactManifestEntry[] =
    delta_link === undefined || delta.reset ? [] : base;
  const by_id = new Map<string, ContactManifestEntry>(
    start.map((entry) => [entry.contact_id, entry]),
  );
  let objects_stored = 0;
  for (const contact of delta.upserted) {
    if (deps.should_interrupt()) return { complete: false, objects_stored };
    const stored = await store_contact_entry(
      deps.ctx,
      deps.connector,
      deps.tenant_id,
      deps.mailbox_id,
      folder.id,
      contact,
    );
    objects_stored += stored.objects_stored;
    by_id.set(contact.id, stored.entry);
  }
  for (const removed_id of delta.removed_ids) by_id.delete(removed_id);
  return {
    complete: true,
    entries: [...by_id.values()],
    delta_link: delta.delta_link,
    objects_stored,
  };
}
