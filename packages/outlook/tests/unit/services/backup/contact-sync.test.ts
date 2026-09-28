import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ContactChange, ContactFolder, Manifest } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';

const owner = 'john.doe@example.com';
const folders: ContactFolder[] = [
  { folder_id: 'default', display_name: 'Contacts', is_default: true },
  { folder_id: 'custom', display_name: 'Example Folder', is_default: false },
];
const person: ContactChange = {
  contact_id: 'c1',
  removed: false,
  payload: { id: 'c1', displayName: 'John Doe', emailAddresses: [{ address: owner }] },
};

function enable_contact_pages(
  harness: ReturnType<typeof create_mailbox_sync_harness>,
  pages: Record<string, ContactChange[]>,
) {
  vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue(folders);
  vi.mocked(harness.mock_contacts.fetch_contact_delta).mockImplementation(
    async (_tenant, _owner, folder, _link, on_page) => {
      await on_page(pages[folder] ?? []);
      return { delta_link: `https://graph.example/delta/${folder}`, reset: false };
    },
  );
}

function head(): Manifest {
  return {
    id: 'head',
    tenant_id: 'test-tenant',
    owner_id: owner,
    snapshot_id: 'snap-head',
    created_at: new Date('2026-09-01T00:00:00Z'),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    id_format: 'immutable',
    entries: [],
    contact_folders: folders,
    contact_entries: [
      {
        contact_id: 'c1',
        folder_id: 'custom',
        change_type: 'stored',
        storage_key: 'contacts/data/john.doe@example.com/old',
        checksum: 'old',
        size_bytes: 3,
      },
    ],
  };
}

describe('opt-in contact backup', () => {
  it('captures default and custom folders, a contact and its photo in encrypted content-addressed objects', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, { custom: [person] });
    vi.mocked(harness.mock_contacts.fetch_contact_photo).mockResolvedValue(Buffer.from('photo'));
    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });

    expect(result.manifest.contact_folders).toEqual(folders);
    const [entry] = result.manifest.contact_entries ?? [];
    expect(entry?.change_type).toBe('stored');
    if (entry?.change_type !== 'stored') throw new Error('Expected stored contact');
    const hash = createHash('sha256').update(JSON.stringify(person.payload)).digest('hex');
    expect(entry.storage_key).toBe(`contacts/data/${owner}/${hash}`);
    expect(entry.photo?.size_bytes).toBe(5);
    expect(vi.mocked(harness.mock_context.storage.put).mock.calls.map(([key]) => key)).toEqual([
      entry.storage_key,
      entry.photo?.storage_key,
    ]);
    expect(vi.mocked(harness.mock_cursors.save).mock.calls[0]?.[1].contact_delta_links).toEqual({
      default: 'https://graph.example/delta/default',
      custom: 'https://graph.example/delta/custom',
    });
  });

  it('keeps the final version when Graph returns the same contact twice in a delta round', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, {});
    const updated: ContactChange = {
      ...person,
      payload: { ...person.payload, companyName: 'Example Org' },
    };
    vi.mocked(harness.mock_contacts.fetch_contact_delta).mockImplementation(
      async (_tenant, _owner, folder_id, _link, on_page) => {
        if (folder_id === 'custom') {
          await on_page([person]);
          await on_page([updated]);
        }
        return { delta_link: 'final', reset: false };
      },
    );
    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });

    const [entry] = result.manifest.contact_entries ?? [];
    expect(result.manifest.contact_entries).toHaveLength(1);
    expect(entry?.change_type).toBe('stored');
    if (entry?.change_type !== 'stored') throw new Error('Expected stored contact');
    expect(entry.checksum).toBe(
      createHash('sha256').update(JSON.stringify(updated.payload)).digest('hex'),
    );
  });

  it('advances contact cursors without a new manifest when folder enumeration order changes', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, {});
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([...folders].reverse());
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(head());
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: owner,
      delta_links: {},
      contact_folders: folders,
      contact_delta_links: { default: 'old-1', custom: 'old-2' },
      updated_at: '2026-09-01T00:00:00Z',
    });

    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });

    expect(result.snapshot.id).toBe('snap-head');
    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(harness.mock_context.storage.put).not.toHaveBeenCalled();
    expect(
      vi.mocked(harness.mock_contacts.fetch_contact_delta).mock.calls.map((call) => call[3]),
    ).toEqual(['old-2', 'old-1']);
  });

  it('keeps a failed contact in the cursor ledger until a later run stores it', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, { custom: [person] });
    vi.mocked(harness.mock_context.storage.put).mockRejectedValueOnce(new Error('S3 unavailable'));
    const failed = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });
    expect(failed.summary.folder_errors).toHaveLength(1);
    expect(failed.manifest.contact_entries).toEqual([]);
    const cursor = vi.mocked(harness.mock_cursors.save).mock.calls[0]?.[1];
    expect(cursor?.failed_contacts?.c1?.attempts).toBe(1);

    vi.mocked(harness.mock_cursors.load).mockResolvedValue(cursor);
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(failed.manifest);
    vi.mocked(harness.mock_contacts.fetch_contact).mockResolvedValue(person.payload!);
    enable_contact_pages(harness, {});
    const recovered = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });
    expect(recovered.manifest.contact_entries?.[0]?.change_type).toBe('stored');
    expect(vi.mocked(harness.mock_cursors.save).mock.calls[1]?.[1].failed_contacts).toEqual({});
  });

  it('records a deletion rather than restoring an older version', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, { custom: [{ contact_id: 'c1', removed: true }] });
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(head());
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: owner,
      delta_links: {},
      contact_folders: folders,
      contact_delta_links: { default: 'old-1', custom: 'old-2' },
      updated_at: '2026-09-01T00:00:00Z',
    });
    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });
    expect(result.manifest.contact_entries).toEqual([
      { contact_id: 'c1', folder_id: 'custom', change_type: 'deleted' },
    ]);
  });
  it('tombstones contacts absent from a completed full re-crawl', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, {});
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(head());
    vi.mocked(harness.mock_manifests.list_all_manifests).mockResolvedValue([head()]);
    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
      force_full: true,
    });
    expect(result.manifest.contact_entries).toEqual([
      { contact_id: 'c1', folder_id: 'custom', change_type: 'deleted' },
    ]);
  });

  it('keeps the previous cursor when interrupted during a contact page', async () => {
    const harness = create_mailbox_sync_harness();
    enable_contact_pages(harness, {});
    let interrupted = false;
    vi.mocked(harness.mock_contacts.fetch_contact_photo).mockImplementation(async () => {
      interrupted = true;
      return undefined;
    });
    vi.mocked(harness.mock_contacts.fetch_contact_delta).mockImplementation(
      async (_tenant, _owner, folder_id, link, on_page) => {
        if (folder_id !== 'custom') return { delta_link: 'new-default', reset: false };
        const complete = await on_page([person]);
        return { ...(complete ? { delta_link: 'new-custom' } : {}), reset: false };
      },
    );
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(head());
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: owner,
      delta_links: {},
      contact_delta_links: { default: 'old-default', custom: 'old-custom' },
      contact_folders: folders,
      updated_at: '2026-09-01T00:00:00Z',
    });
    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
      should_interrupt: () => interrupted,
    });
    expect(result.interrupted).toBe(true);
    expect(vi.mocked(harness.mock_cursors.save).mock.calls[0]?.[1].contact_delta_links).toEqual({
      default: 'new-default',
      custom: 'old-custom',
    });
  });

  it('keeps the mail snapshot and previous contact cursor after a transient contact failure', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_contacts.list_contact_folders).mockRejectedValue(
      new Error('Graph unavailable'),
    );
    vi.mocked(harness.mock_cursors.load).mockResolvedValue({
      owner_id: owner,
      delta_links: {},
      contact_delta_links: { default: 'old-default' },
      contact_folders: folders,
      updated_at: '2026-09-01T00:00:00Z',
    });

    const result = await harness.service.sync_mailbox('test-tenant', owner, {
      include_contacts: true,
    });

    expect(harness.mock_manifests.save).toHaveBeenCalledOnce();
    expect(result.summary.folder_errors).toEqual(['Contacts: Graph unavailable']);
    expect(vi.mocked(harness.mock_cursors.save).mock.calls[0]?.[1].contact_delta_links).toEqual({
      default: 'old-default',
    });
  });
});
