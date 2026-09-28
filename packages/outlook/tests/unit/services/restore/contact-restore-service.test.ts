import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  Manifest,
  RestoreConnector,
  StoredContactEntry,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { RestoreService } from '@/services/restore/restore.service';
import { create_mailbox_sync_harness } from '../backup/mailbox-sync.fixtures';

const owner_id = 'john.doe@example.com';
const root = { folder_id: 'source-default', display_name: 'Contacts', is_default: true };
const payload = {
  displayName: 'John Doe',
  emailAddresses: [{ address: owner_id }],
};
const bytes = Buffer.from(JSON.stringify(payload));
const checksum = createHash('sha256').update(bytes).digest('hex');
const contact: StoredContactEntry = {
  contact_id: 'source-contact',
  folder_id: root.folder_id,
  change_type: 'stored',
  storage_key: `contacts/data/${owner_id}/${checksum}`,
  checksum,
  size_bytes: bytes.length,
};

function manifest(
  snapshot_id: string,
  created_at: string,
  entries: Manifest['contact_entries'] = [],
): Manifest {
  return {
    id: snapshot_id,
    tenant_id: 'tenant',
    owner_id,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    entries: [],
    contact_folders: [root],
    contact_entries: entries,
  };
}

describe('RestoreService.restore_contacts', () => {
  it('uses the target snapshot chain, excluding newer and foreign manifests', async () => {
    const harness = create_mailbox_sync_harness();
    const older = manifest('older', '2026-09-01T00:00:00Z', [contact]);
    const target = manifest('target', '2026-09-02T00:00:00Z');
    const newer = manifest('newer', '2026-09-03T00:00:00Z', [
      { contact_id: contact.contact_id, folder_id: root.folder_id, change_type: 'deleted' },
    ]);
    const foreign = { ...older, owner_id: 'jane.roe@example.com', snapshot_id: 'foreign' };
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(target);
    vi.mocked(harness.mock_manifests.list_all_manifests).mockResolvedValue([newer, foreign, older]);
    vi.mocked(harness.mock_context.storage.get).mockResolvedValue(
      Buffer.concat([Buffer.from('E'), bytes]),
    );
    vi.mocked(harness.mock_contacts.list_contact_folders).mockResolvedValue([
      { folder_id: 'target-default', display_name: 'Contacts', is_default: true },
    ]);
    vi.mocked(harness.mock_contacts.create_contact).mockResolvedValue('restored-contact');
    const factory: TenantContextFactory = {
      create: vi.fn(async () => harness.mock_context),
      create_readonly: vi.fn(async () => harness.mock_context),
      create_storage_only: vi.fn(async () => harness.mock_context),
    };
    const service = new RestoreService(
      factory,
      harness.mock_manifests,
      harness.mock_connector,
      {} as RestoreConnector,
      harness.mock_contacts,
    );

    const result = await service.restore_contacts('tenant', target.snapshot_id);

    expect(result).toMatchObject({ restored_count: 1, errors: [], interrupted: false });
    expect(harness.mock_contacts.create_contact).toHaveBeenCalledWith(
      'tenant',
      owner_id,
      'target-default',
      payload,
    );
    expect(harness.mock_context.destroy).toHaveBeenCalledOnce();
  });
});
