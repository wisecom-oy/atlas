import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RestoreService } from '@/services/restore/restore.service';
import type { MailboxConnector } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import {
  make_restore_entry as make_entry,
  make_restore_manifest as make_manifest,
  make_restore_harness,
  STORED_PAYLOAD_CHECKSUM,
} from './restore.service.fixtures';

describe('RestoreService', () => {
  let mock_context: TenantContext;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let mock_restore: RestoreConnector;
  let service: RestoreService;

  beforeEach(() => {
    ({ service, mock_context, mock_manifests, mock_connector, mock_restore } =
      make_restore_harness());
  });

  it('throws when target mailbox does not exist', async () => {
    const manifest = make_manifest([make_entry('msg-1', 'f1')]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(
      service.restore_snapshot('test-tenant', 'snap-1', { target_mailbox: 'nobody@test.com' }),
    ).rejects.toThrow('does not exist in the tenant');

    expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(mock_restore.create_message).not.toHaveBeenCalled();
  });

  it('throws when source mailbox does not exist (no target override)', async () => {
    const manifest = make_manifest([make_entry('msg-1', 'f1')]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(service.restore_snapshot('test-tenant', 'snap-1')).rejects.toThrow(
      'does not exist in the tenant',
    );
  });

  it('throws when manifest not found', async () => {
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await expect(service.restore_snapshot('test-tenant', 'bad-snap')).rejects.toThrow(
      'No manifest found',
    );
  });

  it('returns empty result when no entries match', async () => {
    const manifest = make_manifest([]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const on_progress = vi.fn();
    const result = await service.restore_snapshot('test-tenant', 'snap-1', { on_progress });
    expect(result.restored_count).toBe(0);
    expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(on_progress.mock.calls.map(([event]) => event.phase)).toEqual([
      'discovering',
      'finalizing',
      'completed',
    ]);
  });

  it('restores a single message by index', async () => {
    const entries = [make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1', {
      message_ref: '1',
    });

    expect(result.restored_count).toBe(1);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(1);
  });

  it('restores messages grouped by folder', async () => {
    const entries = [
      make_entry('msg-1', 'f1'),
      make_entry('msg-2', 'f1'),
      make_entry('msg-3', 'f2'),
    ];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restored_count).toBe(3);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(3);
    expect(mock_restore.create_mail_folder).toHaveBeenCalledTimes(3);
  });

  it('restores messages captured by earlier snapshots in the chain (#432)', async () => {
    const first = { ...make_manifest([make_entry('msg-1', 'f1')]), created_at: new Date(1) };
    const delta = {
      ...make_manifest([make_entry('msg-2', 'f1')]),
      snapshot_id: 'snap-2',
      created_at: new Date(2),
    };
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(delta);
    vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([first, delta]);

    const result = await service.restore_snapshot('test-tenant', 'snap-2');

    expect(result.restored_count).toBe(2);
  });

  it('returns partial counts and stops before the next message when interrupted', async () => {
    const manifest = make_manifest([
      make_entry('msg-1', 'f1'),
      make_entry('msg-2', 'f1'),
      make_entry('msg-3', 'f1'),
    ]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    let interrupted = false;
    vi.mocked(mock_restore.create_message).mockImplementation(async () => {
      interrupted = true;
      return 'new-msg-id';
    });
    const on_progress = vi.fn();

    const result = await service.restore_snapshot('test-tenant', 'snap-1', {
      should_interrupt: () => interrupted,
      on_progress,
    });

    expect(mock_restore.create_message).toHaveBeenCalledOnce();
    expect(result.restored_count).toBe(1);
    expect(result.interrupted).toBe(true);
    expect(on_progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'restore', workload: 'outlook', phase: 'interrupted' }),
    );
  });

  it('restores attachments alongside messages', async () => {
    const entry: ManifestEntry = {
      ...make_entry('msg-1', 'f1'),
      attachments: [
        {
          attachment_id: 'a1',
          name: 'file.pdf',
          content_type: 'application/pdf',
          size_bytes: 512,
          storage_key: 'attachments/user/hash1',
          checksum: STORED_PAYLOAD_CHECKSUM,
          is_inline: false,
        },
      ],
    };
    const manifest = make_manifest([entry]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restored_count).toBe(1);
    expect(result.attachment_count).toBe(1);
    expect(mock_restore.add_attachment).toHaveBeenCalledTimes(1);
  });

  it('normalizes target mailbox to lowercase', async () => {
    const entries = [make_entry('msg-1', 'f1')];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    await service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: 'USER@Test.COM',
    });

    expect(mock_connector.list_mail_folders).toHaveBeenCalledWith('test-tenant', 'user@test.com');
  });

  describe('restore_mailbox', () => {
    it('throws when target mailbox does not exist', async () => {
      (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(
        service.restore_mailbox('test-tenant', 'user@test.com', {
          target_mailbox: 'nobody@test.com',
        }),
      ).rejects.toThrow('does not exist in the tenant');

      expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    });

    it('returns empty when no snapshots for mailbox', async () => {
      (mock_manifests.list_by_owner as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com');
      expect(result.restored_count).toBe(0);
      expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    });

    it('merges entries from multiple snapshots and restores', async () => {
      const m1 = {
        ...make_manifest([make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')]),
        snapshot_id: 'snap-1',
        created_at: new Date('2026-03-08'),
      };
      const m2 = {
        ...make_manifest([make_entry('msg-2', 'f1'), make_entry('msg-3', 'f2')]),
        snapshot_id: 'snap-2',
        created_at: new Date('2026-03-07'),
      };

      (mock_manifests.list_by_owner as ReturnType<typeof vi.fn>).mockResolvedValue([m1, m2]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com');
      expect(mock_manifests.list_by_owner).toHaveBeenCalledWith(mock_context, 'user@test.com');
      expect(result.restored_count).toBe(3);
      expect(mock_restore.create_message).toHaveBeenCalledTimes(3);
    });

    it('filters by date range', async () => {
      const old_manifest = {
        ...make_manifest([make_entry('msg-old', 'f1')]),
        snapshot_id: 'snap-old',
        created_at: new Date('2026-01-01'),
      };
      const new_manifest = {
        ...make_manifest([make_entry('msg-new', 'f1')]),
        snapshot_id: 'snap-new',
        created_at: new Date('2026-03-08'),
      };

      (mock_manifests.list_by_owner as ReturnType<typeof vi.fn>).mockResolvedValue([
        old_manifest,
        new_manifest,
      ]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com', {
        start_date: new Date('2026-03-01'),
      });

      expect(result.restored_count).toBe(1);
    });

    it('restores to target mailbox when specified', async () => {
      const manifest = {
        ...make_manifest([make_entry('msg-1', 'f1')]),
        snapshot_id: 'snap-1',
        created_at: new Date('2026-03-08'),
      };

      (mock_manifests.list_by_owner as ReturnType<typeof vi.fn>).mockResolvedValue([manifest]);

      await service.restore_mailbox('test-tenant', 'user@test.com', {
        target_mailbox: 'OTHER@TEST.COM',
      });

      expect(mock_connector.list_mail_folders).toHaveBeenCalledWith('test-tenant', 'user@test.com');
      expect(mock_restore.create_mail_folder).toHaveBeenCalledWith(
        'test-tenant',
        'other@test.com',
        expect.any(String),
      );
    });
  });
});
