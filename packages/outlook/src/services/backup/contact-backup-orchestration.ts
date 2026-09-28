import type {
  ContactConnector,
  ManifestRepository,
  StoredContactEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { resolve_contact_snapshot } from '@wisecom/atlas-core/services/shared/contact-snapshot-chain';
import {
  sync_contacts,
  type ContactSyncOptions,
  type ContactSyncResult,
} from '@/services/backup/contact-sync';

/** Runs contacts sync, reading snapshot history only when a full re-crawl needs tombstones. */
export async function sync_contacts_with_history(
  ctx: TenantContext,
  connector: ContactConnector,
  manifests: ManifestRepository,
  tenant_id: string,
  owner_id: string,
  options: ContactSyncOptions,
): Promise<ContactSyncResult> {
  let historical: StoredContactEntry[] | undefined;
  return sync_contacts(ctx, connector, tenant_id, owner_id, {
    ...options,
    load_previous_entries: async () => {
      if (!historical) {
        const chain = (await manifests.list_all_manifests(ctx))
          .filter((manifest) => manifest.owner_id === owner_id)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        historical = resolve_contact_snapshot(chain).entries;
      }
      return historical;
    },
  });
}
