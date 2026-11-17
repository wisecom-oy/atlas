import type { ContactManifestEntry, ContactsConnector, TenantContext } from '@wisecom/atlas-types';

import {
  is_already_present,
  type TargetFolderContacts,
} from '@/services/restore/target-folder-contacts';
import { assert_checksum, read_content } from '@/services/shared/content-objects';
import { is_record } from '@/services/shared/json-record';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { source_tag_property } from '@/services/shared/source-tag';

/** Graph-owned fields that Graph rejects or regenerates on create. */
const READ_ONLY_FIELDS: Readonly<Record<string, true>> = {
  id: true,
  parentFolderId: true,
  createdDateTime: true,
  lastModifiedDateTime: true,
  changeKey: true,
};

export interface RestoreWriteDeps {
  readonly ctx: TenantContext;
  readonly connector: ContactsConnector;
  readonly tenant_id: string;
  readonly target_mailbox_id: string;
}

/** A restored contact whose photo failed still counts as restored; `photo_error` says why. */
export type EntryOutcome =
  { readonly status: 'skipped' } | { readonly status: 'restored'; readonly photo_error?: unknown };

async function read_contact(
  ctx: TenantContext,
  entry: ContactManifestEntry,
): Promise<Readonly<Record<string, unknown>>> {
  const bytes = await read_content(ctx, entry.storage_key);
  assert_checksum(ctx, bytes, entry.checksum, 'Contact object');
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!is_record(parsed)) throw new Error('Contact object is not a JSON object');
  return parsed;
}

/** The verified photo bytes, or the reason the stored photo cannot be used. */
type PhotoRead =
  { readonly photo: Buffer | undefined } | { readonly photo: undefined; readonly error: unknown };

/** Reads and checksums the stored photo before anything is written to the mailbox. */
async function read_photo(deps: RestoreWriteDeps, entry: ContactManifestEntry): Promise<PhotoRead> {
  if (entry.photo_storage_key === undefined) return { photo: undefined };
  try {
    const photo = await read_content(deps.ctx, entry.photo_storage_key);
    assert_checksum(deps.ctx, photo, entry.photo_checksum ?? '', 'Contact photo');
    return { photo };
  } catch (err) {
    return { photo: undefined, error: err };
  }
}

/** The create payload: the stored contact without Graph-owned fields, tagged with its source id. */
function restore_payload(
  contact: Readonly<Record<string, unknown>>,
  source_contact_id: string,
): Record<string, unknown> {
  const payload = Object.fromEntries(
    Object.entries(contact).filter(
      ([field]) => !field.startsWith('@') && READ_ONLY_FIELDS[field] !== true,
    ),
  );
  payload['singleValueExtendedProperties'] = [source_tag_property(source_contact_id)];
  return payload;
}

/**
 * Restores one manifest entry into a target folder. An entry already present (see
 * `is_already_present`) is skipped, so restore never overwrites existing data. The created
 * contact is tagged with its source contact id so a rerun skips it. The photo is verified before
 * the contact is created; a bad stored photo or a failed upload still restores the contact and
 * is returned as `photo_error`, because a rerun would skip the contact and never retry the photo.
 */
export async function restore_entry(
  deps: RestoreWriteDeps,
  entry: ContactManifestEntry,
  folder_id: string,
  existing: TargetFolderContacts,
): Promise<EntryOutcome> {
  const contact = await read_contact(deps.ctx, entry);
  if (is_already_present(existing, entry.contact_id, contact)) return { status: 'skipped' };
  const photo = await read_photo(deps, entry);

  const payload = restore_payload(contact, entry.contact_id);
  const contact_id = await deps.connector.create_contact(
    deps.tenant_id,
    deps.target_mailbox_id,
    folder_id,
    payload,
  );
  if ('error' in photo) return { status: 'restored', photo_error: photo.error };
  if (photo.photo === undefined) return { status: 'restored' };
  try {
    await deps.connector.upload_contact_photo(
      deps.tenant_id,
      deps.target_mailbox_id,
      folder_id,
      contact_id,
      photo.photo,
    );
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    return { status: 'restored', photo_error: err };
  }
  return { status: 'restored' };
}
