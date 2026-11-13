import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { RestoreService } from '@/services/restore/restore.service';
import type { MailboxConnector, RestoreConnector, TenantContext } from '@wisecom/atlas-types';
import type { StubOwnerLeases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import {
  make_restore_entry as make_entry,
  make_restore_manifest as make_manifest,
  make_restore_harness,
} from './restore.service.fixtures';

/**
 * Issue #735: a `--message` reference that names no message in the snapshot must fail with
 * NotFoundError before the run takes its lease, checks the mailbox, or creates the restore folder.
 */
describe('RestoreService with a message reference that names no message (#735)', () => {
  let service: RestoreService;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let mock_restore: RestoreConnector;
  let mock_context: TenantContext;
  let owner_leases: StubOwnerLeases;

  beforeEach(() => {
    ({ service, mock_manifests, mock_connector, mock_restore, mock_context, owner_leases } =
      make_restore_harness());
    const manifest = make_manifest([make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')]);
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
  });

  it.each(['99', 'AAMkAG-no-such-id'])(
    'rejects %j with NotFoundError that names the reference',
    async (message_ref) => {
      const run = service.restore_snapshot('test-tenant', 'snap-1', { message_ref });

      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow(`No message matches "${message_ref}" in snapshot snap-1`);
    },
  );

  it('creates no restore folder, writes no message, and takes no lease before rejecting', async () => {
    await expect(
      service.restore_snapshot('test-tenant', 'snap-1', { message_ref: '99' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(mock_restore.create_message).not.toHaveBeenCalled();
    expect(mock_connector.mailbox_exists).not.toHaveBeenCalled();
    expect(owner_leases.requests).toEqual([]);
    expect(mock_context.storage.get).not.toHaveBeenCalled();
  });

  it('restores a message carried over from an earlier snapshot of the chain (#432, #735)', async () => {
    const first = { ...make_manifest([make_entry('msg-1', 'f1')]), created_at: new Date(1) };
    const delta = {
      ...make_manifest([make_entry('msg-2', 'f1')]),
      snapshot_id: 'snap-2',
      created_at: new Date(2),
    };
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(delta);
    vi.mocked(mock_manifests.list_by_owner).mockResolvedValue([first, delta]);

    const result = await service.restore_snapshot('test-tenant', 'snap-2', {
      message_ref: 'msg-1',
    });

    expect(result.restored_count).toBe(1);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(1);
  });
});
