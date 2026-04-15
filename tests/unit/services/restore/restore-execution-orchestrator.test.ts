import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  restore_folder_entries,
  restore_single_message,
} from '@/services/restore/restore-execution-orchestrator';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { ManifestEntry } from '@/domain/manifest';
import type { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';

vi.mock('@/services/restore/restore-message-transformer', () => ({
  decrypt_and_parse_message: vi.fn().mockResolvedValue({
    subject: 'Hi',
    body: { content: 'b', contentType: 'text' },
    receivedDateTime: '2026-01-01T00:00:00Z',
  }),
  sanitize_message_for_restore: vi.fn((x: Record<string, unknown>) => x),
  extract_folder_id_from_json: vi.fn().mockReturnValue('fid-1'),
}));

vi.mock('@/services/restore/restore-attachment-writer', () => ({
  restore_entry_attachments: vi.fn().mockResolvedValue({
    restored: 0,
    skipped: 0,
    errors: ['file.pdf: checksum mismatch'],
  }),
}));

vi.mock('@/services/restore/folder-restore-planner', () => ({
  build_folder_map: vi.fn().mockResolvedValue(new Map([['fid-1', 'Inbox']])),
  create_restore_root: vi
    .fn()
    .mockResolvedValue({ folder_id: 'root-1', display_name: 'Restore-X' }),
  ensure_subfolder: vi.fn().mockResolvedValue('target-fid'),
}));

describe('restore_folder_entries', () => {
  let ctx: TenantContext;
  let restore_connector: RestoreConnector;
  let dashboard: RestoreProgressDashboard;

  beforeEach(() => {
    ctx = {
      tenant_id: 't',
      storage: {} as never,
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      destroy: vi.fn(),
    } as TenantContext;
    restore_connector = {
      create_message: vi.fn().mockResolvedValue('new-msg'),
    } as unknown as RestoreConnector;
    dashboard = {
      update_active: vi.fn(),
      update_total: vi.fn(),
    } as unknown as RestoreProgressDashboard;
  });

  it('separates attachment errors from message errors in folder outcome', async () => {
    const entry: ManifestEntry = {
      object_id: 'o1',
      storage_key: 'k',
      checksum: 'x',
      size_bytes: 1,
      attachments: [
        {
          attachment_id: 'a1',
          name: 'file.pdf',
          content_type: 'application/pdf',
          size_bytes: 1,
          storage_key: 'att/k',
          checksum: 'c',
          is_inline: false,
        },
      ],
    };

    const result = await restore_folder_entries(
      ctx,
      restore_connector,
      't',
      'm@t.com',
      'folder-1',
      [entry],
      0,
      0,
      1,
      Date.now(),
      dashboard,
      () => false,
    );

    expect(result.restored).toBe(1);
    expect(result.attachment_errors).toBe(1);
    expect(result.att_error_details).toContain('file.pdf: checksum mismatch');
    expect(result.errors).toHaveLength(0);
  });
});

describe('restore_single_message', () => {
  it('returns attachment errors in RestoreResult', async () => {
    const ctx = {
      tenant_id: 't',
      storage: {} as never,
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      destroy: vi.fn(),
    } as TenantContext;
    const restore_connector = {
      create_message: vi.fn().mockResolvedValue('nm'),
    } as unknown as RestoreConnector;
    const mailbox_connector = {} as unknown as MailboxConnector;

    const entry: ManifestEntry = {
      object_id: 'o1',
      storage_key: 'k',
      checksum: 'x',
      size_bytes: 1,
      folder_id: 'fid-1',
      attachments: [
        {
          attachment_id: 'a1',
          name: 'f',
          content_type: 't',
          size_bytes: 1,
          storage_key: 's',
          checksum: 'c',
          is_inline: false,
        },
      ],
    };

    const result = await restore_single_message(
      ctx,
      mailbox_connector,
      restore_connector,
      't',
      'src@t.com',
      'dst@t.com',
      'snap-1',
      entry,
    );

    expect(result.error_count).toBe(0);
    expect(result.attachment_error_count).toBe(1);
    expect(result.attachment_errors[0]).toContain('checksum mismatch');
  });
});
