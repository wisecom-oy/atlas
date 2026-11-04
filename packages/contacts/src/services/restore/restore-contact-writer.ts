import type { ContactManifestEntry, ContactsConnector, TenantContext } from '@wisecom/atlas-types';

import { collision_key } from '@/services/restore/collision-key';
import { assert_checksum, read_content } from '@/services/shared/content-objects';
import { is_record } from '@/services/shared/json-record';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

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

async function restore_photo(
  deps: RestoreWriteDeps,
  entry: ContactManifestEntry,
  folder_id: string,
  contact_id: string,
): Promise<void> {
  if (entry.photo_storage_key === undefined) return;
  const photo = await read_content(deps.ctx, entry.photo_storage_key);
  assert_checksum(deps.ctx, photo, entry.photo_checksum ?? '', 'Contact photo');
  await deps.connector.upload_contact_photo(
    deps.tenant_id,
    deps.target_mailbox_id,
    folder_id,
    contact_id,
    photo,
  );
}

/**
 * Restores one manifest entry into a target folder. A contact whose collision key is already
 * present is skipped, so restore never overwrites existing data. A photo failure after the
 * contact was created is returned rather than thrown, because the contact itself landed.
 */
export async function restore_entry(
  deps: RestoreWriteDeps,
  entry: ContactManifestEntry,
  folder_id: string,
  existing_keys: ReadonlySet<string>,
): Promise<EntryOutcome> {
  const contact = await read_contact(deps.ctx, entry);
  const key = collision_key(contact);
  if (key !== undefined && existing_keys.has(key)) return { status: 'skipped' };

  const payload = Object.fromEntries(
    Object.entries(contact).filter(
      ([field]) => !field.startsWith('@') && READ_ONLY_FIELDS[field] !== true,
    ),
  );
  const contact_id = await deps.connector.create_contact(
    deps.tenant_id,
    deps.target_mailbox_id,
    folder_id,
    payload,
  );
  try {
    await restore_photo(deps, entry, folder_id, contact_id);
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    return { status: 'restored', photo_error: err };
  }
  return { status: 'restored' };
}
