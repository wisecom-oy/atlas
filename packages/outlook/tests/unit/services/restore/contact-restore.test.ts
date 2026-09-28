import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Manifest, StoredContactEntry } from '@wisecom/atlas-types';
import { restore_contact_chain } from '@/services/restore/contact-restore';
import { resolve_contact_snapshot } from '@wisecom/atlas-core/services/shared/contact-snapshot-chain';
import { create_mailbox_sync_harness } from '../backup/mailbox-sync.fixtures';

const source_id = 'john.doe@example.com';
const default_folder = { folder_id: 'source-default', display_name: 'Contacts', is_default: true };
const folder = { folder_id: 'source-folder', display_name: 'Example Folder', is_default: false };
const payload = {
  id: 'source-contact',
  displayName: 'John Doe',
  emailAddresses: [{ address: 'john.doe@example.com' }],
  companyName: 'Example Org',
};
const bytes = Buffer.from(JSON.stringify(payload));
const checksum = createHash('sha256').update(bytes).digest('hex');
const entry: StoredContactEntry = {
  contact_id: 'source-contact',
  folder_id: folder.folder_id,
  change_type: 'stored',
  storage_key: `contacts/data/${source_id}/${checksum}`,
  checksum,
  size_bytes: bytes.length,
};
function manifest(
  entries: NonNullable<Manifest['contact_entries']>,
  timestamp: string,
  folders?: Manifest['contact_folders'],
): Manifest {
  return {
    id: timestamp,
    tenant_id: 'tenant',
    owner_id: source_id,
    snapshot_id: timestamp,
    created_at: new Date(timestamp),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    entries: [],
    ...(folders
      ? {
          contact_folders:
            folders.length > 0 && !folders.some((item) => item.is_default)
              ? [default_folder, ...folders]
              : folders,
        }
      : {}),
    contact_entries: entries,
  };
}

describe('contact snapshot restore', () => {
  it('uses the newest contact state and never revives deleted contacts or folders', () => {
    const chain = [
      manifest(
        [{ contact_id: 'source-contact', folder_id: folder.folder_id, change_type: 'deleted' }],
        '2026-09-02T00:00:00Z',
        [],
      ),
      manifest([entry], '2026-09-01T00:00:00Z', [folder]),
    ];
    expect(resolve_contact_snapshot(chain)).toEqual({ folders: [], entries: [] });
  });

  it('prefers a moved contact over its source-folder deletion in the same delta', () => {
    const next = { ...folder, folder_id: 'next-folder' };
    const result = resolve_contact_snapshot([
      manifest(
        [
          { contact_id: entry.contact_id, folder_id: folder.folder_id, change_type: 'deleted' },
          { ...entry, folder_id: next.folder_id },
        ],
        '2026-09-02T00:00:00Z',
        [folder, next],
      ),
      manifest([entry], '2026-09-01T00:00:00Z', [folder]),
    ]);
    expect(result.entries).toEqual([{ ...entry, folder_id: next.folder_id }]);
  });

  it('creates a missing folder, updates an existing contact in place and restores its photo', async () => {
    const harness = create_mailbox_sync_harness();
    const photo = Buffer.from('photo');
    const photo_checksum = createHash('sha256').update(photo).digest('hex');
    const stored = {
      ...entry,
      photo: {
        storage_key: 'contacts/photos/photo',
        checksum: photo_checksum,
        size_bytes: photo.length,
      },
    };
    vi.mocked(harness.mock_context.storage.get).mockImplementation(async (key) =>
      Buffer.concat([Buffer.from('E'), key === stored.storage_key ? bytes : photo]),
    );
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
    ]);
    vi.mocked(harness.mock_contacts.create_contact_folder).mockResolvedValue('target-folder');
    vi.mocked(harness.mock_contacts.list_contacts).mockResolvedValue([
      {
        id: 'target-contact',
        displayName: 'John Doe',
        emailAddresses: [{ address: 'john.doe@example.com' }],
        companyName: 'Old Org',
      },
    ]);
    const result = await restore_contact_chain(
      harness.mock_context,
      harness.mock_contacts,
      'tenant',
      'jane.roe@example.com',
      [manifest([stored], '2026-09-01T00:00:00Z', [folder])],
    );
    expect(result.errors).toEqual([]);
    expect(harness.mock_contacts.update_contact).toHaveBeenCalledWith(
      'tenant',
      'jane.roe@example.com',
      'target-contact',
      expect.objectContaining({ companyName: 'Example Org' }),
    );
    expect(harness.mock_contacts.create_contact).not.toHaveBeenCalled();
    expect(harness.mock_contacts.set_contact_photo).toHaveBeenCalledWith(
      'tenant',
      'jane.roe@example.com',
      'target-contact',
      photo,
    );
  });

  it('recreates nested contact folders under their source parents', async () => {
    const harness = create_mailbox_sync_harness();
    const nested = {
      folder_id: 'source-nested',
      display_name: 'Nested',
      is_default: false,
      parent_folder_id: folder.folder_id,
    };
    vi.mocked(harness.mock_context.storage.get).mockResolvedValue(
      Buffer.concat([Buffer.from('E'), bytes]),
    );
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
    ]);
    vi.mocked(harness.mock_contacts.create_contact_folder)
      .mockResolvedValueOnce('target-parent')
      .mockResolvedValueOnce('target-nested');
    vi.mocked(harness.mock_contacts.create_contact).mockResolvedValue('target-contact');

    const result = await restore_contact_chain(
      harness.mock_context,
      harness.mock_contacts,
      'tenant',
      source_id,
      [
        manifest([{ ...entry, folder_id: nested.folder_id }], '2026-09-01T00:00:00Z', [
          nested,
          folder,
        ]),
      ],
    );
    expect(result.errors).toEqual([]);
    expect(harness.mock_contacts.create_contact_folder).toHaveBeenNthCalledWith(
      1,
      'tenant',
      source_id,
      folder.display_name,
      'target-default',
    );
    expect(harness.mock_contacts.create_contact_folder).toHaveBeenNthCalledWith(
      2,
      'tenant',
      source_id,
      'Nested',
      'target-parent',
    );
    expect(harness.mock_contacts.create_contact).toHaveBeenCalledWith(
      'tenant',
      source_id,
      'target-nested',
      expect.objectContaining({ displayName: 'John Doe' }),
    );
  });

  it('leaves an identical contact and photo unchanged on repeated restore', async () => {
    const harness = create_mailbox_sync_harness();
    const photo = Buffer.from('photo');
    const stored = {
      ...entry,
      photo: {
        storage_key: 'contacts/photos/photo',
        checksum: createHash('sha256').update(photo).digest('hex'),
        size_bytes: photo.length,
      },
    };
    vi.mocked(harness.mock_context.storage.get).mockImplementation(async (key) =>
      Buffer.concat([Buffer.from('E'), key === entry.storage_key ? bytes : photo]),
    );
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
      { folder_id: 'target-folder', display_name: folder.display_name, is_default: false },
    ]);
    vi.mocked(harness.mock_contacts.list_contacts).mockResolvedValue([
      {
        id: 'target-contact',
        companyName: 'Example Org',
        emailAddresses: [{ address: 'john.doe@example.com' }],
        displayName: 'John Doe',
      },
    ]);
    vi.mocked(harness.mock_contacts.fetch_contact_photo).mockResolvedValue(photo);
    const result = await restore_contact_chain(
      harness.mock_context,
      harness.mock_contacts,
      'tenant',
      source_id,
      [manifest([stored], '2026-09-01T00:00:00Z', [folder])],
    );
    expect(result.restored).toBe(0);
    expect(harness.mock_contacts.create_contact).not.toHaveBeenCalled();
    expect(harness.mock_contacts.update_contact).not.toHaveBeenCalled();
    expect(harness.mock_contacts.set_contact_photo).not.toHaveBeenCalled();
  });

  it('restores distinct source contacts that share the same email without overwriting one', async () => {
    const harness = create_mailbox_sync_harness();
    const other_payload = { ...payload, id: 'source-other', displayName: 'Jane Roe' };
    const other_bytes = Buffer.from(JSON.stringify(other_payload));
    const other_checksum = createHash('sha256').update(other_bytes).digest('hex');
    const other: StoredContactEntry = {
      ...entry,
      contact_id: 'source-other',
      storage_key: `contacts/data/${source_id}/${other_checksum}`,
      checksum: other_checksum,
      size_bytes: other_bytes.length,
    };
    vi.mocked(harness.mock_context.storage.get).mockImplementation(async (key) =>
      Buffer.concat([Buffer.from('E'), key === entry.storage_key ? bytes : other_bytes]),
    );
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
      { folder_id: 'target-folder', display_name: folder.display_name, is_default: false },
    ]);
    vi.mocked(harness.mock_contacts.list_contacts).mockResolvedValue([
      { ...payload, id: 'target-contact' },
    ]);
    vi.mocked(harness.mock_contacts.create_contact).mockResolvedValue('target-other');
    const result = await restore_contact_chain(
      harness.mock_context,
      harness.mock_contacts,
      'tenant',
      source_id,
      [manifest([entry, other], '2026-09-01T00:00:00Z', [folder])],
    );
    expect(result.errors).toEqual([]);
    expect(result.restored).toBe(1);
    expect(harness.mock_contacts.update_contact).not.toHaveBeenCalled();
    expect(harness.mock_contacts.create_contact).toHaveBeenCalledOnce();
  });

  it('rejects a corrupted stored contact rather than restoring it', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_context.storage.get).mockResolvedValue(Buffer.from('Ewrong'));
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
    ]);
    vi.mocked(harness.mock_contacts.create_contact_folder).mockResolvedValue('new-folder');
    const result = await restore_contact_chain(
      harness.mock_context,
      harness.mock_contacts,
      'tenant',
      source_id,
      [manifest([entry], '2026-09-01T00:00:00Z', [folder])],
    );
    expect(result.errors).toHaveLength(1);
    expect(harness.mock_contacts.create_contact).not.toHaveBeenCalled();
  });
});
