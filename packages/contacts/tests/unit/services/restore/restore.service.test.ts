import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type {
  ContactFolderRecord,
  ContactManifestEntry,
  ContactsConnector,
  ContactsSnapshotManifest,
  GraphContactPayload,
} from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import {
  contact,
  fake_connector,
  folder,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsRestoreService } from '@/services/restore/restore.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SNAPSHOT = 'ct-snap-1-abc';
const FOLDERS: ContactFolderRecord[] = [
  { folder_id: 'src-default', display_name: 'Contacts', path: [] },
  { folder_id: 'src-sub', display_name: 'Sub', path: ['Sub'] },
];

interface CreatedContact {
  readonly folder_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface TargetConnector {
  readonly connector: ContactsConnector;
  readonly created: CreatedContact[];
  readonly photos: { contact_id: string; bytes: Uint8Array }[];
  readonly created_folders: { parent: string; name: string }[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes a contact (and optional photo) into the object map and returns its manifest entry. */
function stored_entry(
  objects: Record<string, Buffer>,
  contact_id: string,
  folder_id: string,
  payload: Record<string, unknown>,
  photo?: Buffer,
): ContactManifestEntry {
  const bytes = Buffer.from(JSON.stringify(payload));
  const storage_key = `contacts/data/${MAILBOX}/${sha256(bytes)}`;
  objects[storage_key] = bytes;
  const base: ContactManifestEntry = {
    contact_id,
    folder_id,
    storage_key,
    checksum: sha256(bytes),
    size_bytes: bytes.length,
  };
  if (photo === undefined) return base;
  const photo_storage_key = `contacts/photos/${MAILBOX}/${sha256(photo)}`;
  objects[photo_storage_key] = photo;
  return {
    ...base,
    photo_storage_key,
    photo_checksum: sha256(photo),
    photo_size_bytes: photo.length,
  };
}

function snapshot(entries: ContactManifestEntry[]): ContactsSnapshotManifest {
  return {
    id: SNAPSHOT,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: SNAPSHOT,
    created_at: '2025-01-01T00:00:00.000Z',
    total_contacts: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    folders: FOLDERS,
    entries,
  };
}

/**
 * A target mailbox whose only folder is the default one, holding the given contacts. Creates and
 * photo uploads are recorded so tests can assert on what restore wrote.
 */
function target_connector(existing_default: GraphContactPayload[] = []): TargetConnector {
  const fake = fake_connector();
  fake.script.folders = [folder('f-default', 'Contacts')];
  const created: CreatedContact[] = [];
  const photos: { contact_id: string; bytes: Uint8Array }[] = [];
  const created_folders: { parent: string; name: string }[] = [];
  let next_contact = 0;
  const connector: ContactsConnector = {
    ...fake.connector,
    list_folder_contacts: async (_tenant, _mailbox, folder_id) =>
      folder_id === 'f-default' ? existing_default : [],
    create_contact_folder: async (_tenant, _mailbox, parent_id, name) => {
      created_folders.push({ parent: parent_id, name });
      return folder('f-new-sub', name, [name]);
    },
    create_contact: async (_tenant, _mailbox, folder_id, payload) => {
      created.push({ folder_id, payload });
      next_contact += 1;
      return `new-${next_contact}`;
    },
    upload_contact_photo: async (_tenant, _mailbox, _folder, contact_id, bytes) => {
      photos.push({ contact_id, bytes });
    },
  };
  return { connector, created, photos, created_folders };
}

/** Saves a snapshot into an in-memory manifest store and runs a restore of it. */
async function restore_with(
  entries: ContactManifestEntry[],
  objects: Record<string, Buffer>,
  target: TargetConnector,
  options: { should_interrupt?: () => boolean } = {},
) {
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, snapshot(entries));
  const service = new ContactsRestoreService(tenant_factory_for(ctx), target.connector, manifests);
  return service.restore_contacts('tenant-1', MAILBOX, { snapshot_id: SNAPSHOT, ...options });
}

describe('ContactsRestoreService', () => {
  it('creates the missing child folder under the default folder and restores each contact into its folder', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_entry(objects, 'c1', 'src-default', contact('c1')),
      stored_entry(objects, 'c2', 'src-sub', contact('c2')),
    ];
    const target = target_connector();

    const result = await restore_with(entries, objects, target);

    expect(target.created_folders).toEqual([{ parent: 'f-default', name: 'Sub' }]);
    expect(result.folders_created).toBe(1);
    expect(target.created.map((c) => c.folder_id)).toEqual(['f-default', 'f-new-sub']);
    expect(result.contacts_restored).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('skips a contact whose name and email already exist in the target folder', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_entry(objects, 'c1', 'src-default', contact('c1')),
      stored_entry(objects, 'c2', 'src-default', contact('c2')),
    ];
    const existing = { ...contact('c1'), id: 'existing-1' };
    const target = target_connector([existing]);

    const result = await restore_with(entries, objects, target);

    expect(result.contacts_skipped).toBe(1);
    expect(result.contacts_restored).toBe(1);
    expect(target.created.map((c) => c.payload['displayName'])).toEqual(['Contact c2']);
  });

  it('strips Graph read-only fields and @-annotations before creating a contact', async () => {
    const objects: Record<string, Buffer> = {};
    const payload = {
      ...contact('c1'),
      '@odata.etag': 'W/"example"',
      parentFolderId: 'f-default',
      createdDateTime: '2025-01-01T00:00:00Z',
      changeKey: 'example-key',
    };
    const entries = [stored_entry(objects, 'c1', 'src-default', payload)];
    const target = target_connector();

    await restore_with(entries, objects, target);

    expect(Object.keys(target.created[0]?.payload ?? {}).sort()).toEqual([
      'displayName',
      'emailAddresses',
    ]);
  });

  it('uploads the stored photo to the restored contact', async () => {
    const objects: Record<string, Buffer> = {};
    const photo = Buffer.from([1, 2, 3]);
    const entries = [stored_entry(objects, 'c1', 'src-default', contact('c1'), photo)];
    const target = target_connector();

    await restore_with(entries, objects, target);

    expect(target.photos).toHaveLength(1);
    expect(target.photos[0]?.contact_id).toBe('new-1');
    expect(Buffer.from(target.photos[0]?.bytes ?? [])).toEqual(photo);
  });

  it('records a checksum mismatch as an error and continues with the next contact', async () => {
    const objects: Record<string, Buffer> = {};
    const first = stored_entry(objects, 'c1', 'src-default', contact('c1'));
    const entries = [
      { ...first, checksum: '0'.repeat(64) },
      stored_entry(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = target_connector();

    const result = await restore_with(entries, objects, target);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('c1');
    expect(result.contacts_restored).toBe(1);
  });

  it('counts a contact as restored and reports it when only its photo upload fails', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_entry(objects, 'c1', 'src-default', contact('c1'), Buffer.from([1])),
      stored_entry(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = target_connector();
    target.connector.upload_contact_photo = async () => {
      throw new Error('Graph 500');
    };

    const result = await restore_with(entries, objects, target);

    expect(result.contacts_restored).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/c1.*restored without its photo: Graph 500/);
  });

  it('stops the restore on an auth failure instead of failing every contact', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_entry(objects, 'c1', 'src-default', contact('c1')),
      stored_entry(objects, 'c2', 'src-default', contact('c2')),
    ];
    const target = target_connector();
    let attempts = 0;
    target.connector.create_contact = async () => {
      attempts += 1;
      throw new AuthError('denied');
    };

    await expect(restore_with(entries, objects, target)).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
  });

  it('rejects when the snapshot is not in the mailbox', async () => {
    const target = target_connector();
    const { ctx } = stub_tenant_context();
    const service = new ContactsRestoreService(
      tenant_factory_for(ctx),
      target.connector,
      memory_manifests(),
    );

    await expect(
      service.restore_contacts('tenant-1', MAILBOX, { snapshot_id: 'ct-snap-missing' }),
    ).rejects.toThrow(/No contacts snapshot ct-snap-missing/);
  });

  it('restores nothing and reports interrupted when interrupted before the first contact', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_entry(objects, 'c1', 'src-default', contact('c1'))];
    const target = target_connector();

    const result = await restore_with(entries, objects, target, { should_interrupt: () => true });

    expect(result.interrupted).toBe(true);
    expect(result.contacts_restored).toBe(0);
    expect(target.created).toHaveLength(0);
  });
});
