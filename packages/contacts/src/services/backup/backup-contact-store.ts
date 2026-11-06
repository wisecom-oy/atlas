import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  ContactManifestEntry,
  ContactsConnector,
  GraphContactPayload,
  TenantContext,
} from '@wisecom/atlas-types';
import { put_content_if_absent } from '@/services/shared/content-objects';
import { contacts_data_key, contacts_photo_key } from '@/services/shared/storage-keys';

/** Objects a contact contributed and the manifest entry that points at them. */
export interface StoredContact {
  readonly entry: ContactManifestEntry;
  readonly objects_stored: number;
}

/** Stores a contact's JSON and, when present, its photo under keyed content names. */
export async function store_contact_entry(
  ctx: TenantContext,
  connector: ContactsConnector,
  tenant_id: string,
  mailbox_id: string,
  folder_id: string,
  contact: GraphContactPayload,
): Promise<StoredContact> {
  const data = Buffer.from(JSON.stringify(contact));
  const data_digests = compute_content_digests(ctx, data);
  const storage_key = contacts_data_key(mailbox_id, data_digests.content_name);
  let objects_stored = (await put_content_if_absent(ctx, storage_key, data)) ? 1 : 0;
  const entry: ContactManifestEntry = {
    contact_id: contact.id,
    folder_id,
    ...(typeof contact['displayName'] === 'string' ? { display_name: contact['displayName'] } : {}),
    ...(typeof contact['lastModifiedDateTime'] === 'string'
      ? { last_modified_at: contact['lastModifiedDateTime'] }
      : {}),
    storage_key,
    checksum: data_digests.checksum,
    size_bytes: data.length,
  };
  const photo = await connector.fetch_contact_photo(tenant_id, mailbox_id, folder_id, contact.id);
  if (photo === undefined) return { entry, objects_stored };
  const photo_data = Buffer.from(photo);
  const photo_digests = compute_content_digests(ctx, photo_data);
  const photo_storage_key = contacts_photo_key(mailbox_id, photo_digests.content_name);
  if (await put_content_if_absent(ctx, photo_storage_key, photo_data)) objects_stored += 1;
  return {
    entry: {
      ...entry,
      photo_storage_key,
      photo_checksum: photo_digests.checksum,
      photo_size_bytes: photo_data.length,
    },
    objects_stored,
  };
}
