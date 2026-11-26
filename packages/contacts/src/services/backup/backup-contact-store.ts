import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { ContactManifestEntry, GraphContactPayload } from '@wisecom/atlas-types';
import {
  capture_contact_photo,
  type PhotoCaptureScope,
} from '@/services/backup/contact-photo-capture';
import { put_content_if_absent } from '@/services/shared/content-objects';
import { contacts_data_key } from '@/services/shared/storage-keys';

/** Objects a contact contributed and the manifest entry that points at them. */
export interface StoredContact {
  readonly entry: ContactManifestEntry;
  readonly objects_stored: number;
}

/**
 * Stores a contact's JSON and, when it has one, its photo under keyed content names. The photo is
 * requested only when the contact is in `ids_with_attachments`, because a contact photo is an
 * attachment and a contact without one has no photo. `previous` is the contact's entry in the
 * previous snapshot, which a "not found" photo answer builds on.
 */
export async function store_contact_entry(
  scope: PhotoCaptureScope,
  folder_id: string,
  contact: GraphContactPayload,
  ids_with_attachments: ReadonlySet<string>,
  previous: ContactManifestEntry | undefined,
): Promise<StoredContact> {
  const data = Buffer.from(JSON.stringify(contact));
  const data_digests = compute_content_digests(scope.ctx, data);
  const storage_key = contacts_data_key(scope.mailbox_id, data_digests.content_name);
  const data_stored = (await put_content_if_absent(scope.ctx, storage_key, data)) ? 1 : 0;
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
  if (!ids_with_attachments.has(contact.id)) return { entry, objects_stored: data_stored };
  const photo = await capture_contact_photo(scope, entry, previous);
  return { entry: photo.entry, objects_stored: data_stored + photo.objects_stored };
}
