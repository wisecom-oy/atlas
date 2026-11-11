import { createHash } from 'node:crypto';

import type {
  ContactFolderRecord,
  ContactManifestEntry,
  ContactsSnapshotManifest,
} from '@/domain/contacts/manifest';
import type { ContactsConnector, GraphContactPayload } from '@/ports/contacts/connector.port';
import { fake_connector, folder } from '@/testing/stub-contacts-ports';

export const CONTACTS_MAILBOX = '00000000-0000-0000-0000-00000000abcd';
export const CONTACTS_SNAPSHOT = 'ct-snap-1-abc';
/** Extended property that stamps each restored contact with its source contact id. */
export const SOURCE_CONTACT_TAG_ID =
  'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceContactId';

/** Source folders of a snapshot: the default Contacts folder and one child folder `Sub`. */
export const SOURCE_CONTACT_FOLDERS: ContactFolderRecord[] = [
  { folder_id: 'src-default', display_name: 'Contacts', path: [] },
  { folder_id: 'src-sub', display_name: 'Sub', path: ['Sub'] },
];

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stores a contact (and optional photo) the way the backup does and returns its manifest entry. */
export function stored_contact(
  objects: Record<string, Buffer>,
  contact_id: string,
  folder_id: string,
  payload: Record<string, unknown>,
  photo?: Buffer,
): ContactManifestEntry {
  const bytes = Buffer.from(JSON.stringify(payload));
  const storage_key = `contacts/data/${CONTACTS_MAILBOX}/${sha256(bytes)}`;
  objects[storage_key] = bytes;
  const base: ContactManifestEntry = {
    contact_id,
    folder_id,
    storage_key,
    checksum: sha256(bytes),
    size_bytes: bytes.length,
  };
  if (photo === undefined) return base;
  const photo_storage_key = `contacts/photos/${CONTACTS_MAILBOX}/${sha256(photo)}`;
  objects[photo_storage_key] = photo;
  return {
    ...base,
    photo_storage_key,
    photo_checksum: sha256(photo),
    photo_size_bytes: photo.length,
  };
}

/** The snapshot manifest a backup run would have left behind. */
export function contacts_snapshot(
  entries: ContactManifestEntry[],
  folders: ContactFolderRecord[] = SOURCE_CONTACT_FOLDERS,
): ContactsSnapshotManifest {
  return {
    id: CONTACTS_SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: CONTACTS_MAILBOX,
    snapshot_id: CONTACTS_SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_contacts: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    folders,
    entries,
  };
}

/** One contact a restore created, with the folder it went into. */
export interface CreatedContact {
  readonly folder_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ContactsTarget {
  readonly connector: ContactsConnector;
  /** Contacts per target folder id; created contacts are added, so a rerun lists them. */
  readonly contacts: Record<string, GraphContactPayload[]>;
  readonly created: CreatedContact[];
  readonly photos: { contact_id: string; bytes: Uint8Array }[];
  readonly created_folders: { parent: string; name: string }[];
}

/**
 * A target mailbox that starts with only its default folder (`f-default`) holding the given
 * contacts. Created folders and contacts are kept, so a second restore sees the first one's output.
 */
export function contacts_target(existing_default: GraphContactPayload[] = []): ContactsTarget {
  const fake = fake_connector();
  fake.script.folders = [folder('f-default', 'Contacts')];
  const contacts: Record<string, GraphContactPayload[]> = { 'f-default': [...existing_default] };
  const created: CreatedContact[] = [];
  const photos: { contact_id: string; bytes: Uint8Array }[] = [];
  const created_folders: { parent: string; name: string }[] = [];
  const connector: ContactsConnector = {
    ...fake.connector,
    list_folder_contacts: async (_tenant, _mailbox, folder_id) => [...(contacts[folder_id] ?? [])],
    create_contact_folder: async (_tenant, _mailbox, parent_id, name) => {
      created_folders.push({ parent: parent_id, name });
      const parent_path = fake.script.folders.find((f) => f.id === parent_id)?.path ?? [];
      const made = folder(`f-new-${created_folders.length}`, name, [...parent_path, name]);
      fake.script.folders.push(made);
      return folder(made.id, name);
    },
    create_contact: async (_tenant, _mailbox, folder_id, payload) => {
      created.push({ folder_id, payload });
      const id = `new-${created.length}`;
      (contacts[folder_id] ??= []).push({ ...payload, id });
      return id;
    },
    upload_contact_photo: async (_tenant, _mailbox, _folder, contact_id, bytes) => {
      photos.push({ contact_id, bytes });
    },
  };
  return { connector, contacts, created, photos, created_folders };
}
