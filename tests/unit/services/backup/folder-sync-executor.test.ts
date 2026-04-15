import { describe, it, expect, vi } from 'vitest';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { MailMessage } from '@/ports/mailbox/connector.port';
import type { BackupProgressReporter } from '@/ports/backup/use-case.port';

vi.mock('@/services/backup/attachment-storage-sync', () => ({
  fetch_and_store_attachments: vi.fn().mockResolvedValue([]),
}));

function make_message(id: string): MailMessage {
  return {
    message_id: id,
    folder_id: 'folder-1',
    subject: 'Subj',
    received_at: new Date(),
    size_bytes: 4,
    raw_body: Buffer.from('body'),
    has_attachments: false,
  };
}

describe('sync_single_folder', () => {
  it('processes streamed pages and stores new messages', async () => {
    const msg = make_message('mid-1');
    const connector: MailboxConnector = {
      fetch_delta: vi
        .fn()
        .mockImplementation(
          async (
            _t,
            _m,
            _folder,
            _prev,
            on_page?: (p: number, n: number, m: MailMessage[]) => unknown,
          ) => {
            if (on_page) {
              await on_page(1, 1, [msg]);
            }
            return {
              messages: [],
              removed_ids: [],
              delta_link: 'https://graph/delta',
              delta_reset: false,
            };
          },
        ),
    } as unknown as MailboxConnector;

    const ctx: TenantContext = {
      tenant_id: 't',
      storage: {
        exists: vi.fn().mockResolvedValue(false),
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        delete: vi.fn(),
        delete_version: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn(),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn((b: Buffer) => Buffer.concat([Buffer.from('E'), b])),
      decrypt: vi.fn((b: Buffer) => b.subarray(1)),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    const progress: BackupProgressReporter = {
      set_status: vi.fn(),
      mark_active: vi.fn(),
      update_active: vi.fn(),
      update_paging: vi.fn(),
      mark_done: vi.fn(),
      mark_all_pending_interrupted: vi.fn(),
      mark_error: vi.fn(),
      update_total: vi.fn(),
      finish: vi.fn(),
    };

    const result = await sync_single_folder({
      ctx,
      connector,
      tenant_id: 't',
      mailbox_id: 'm@t.com',
      folder_id: 'folder-1',
      folder_index: 0,
      folder_total: 1,
      global_total: 1,
      global_processed_before: 0,
      sync_start: Date.now(),
      progress,
      is_interrupted: () => false,
      is_hard_stopped: () => false,
    });

    expect(result.stored).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.delta_link).toBe('https://graph/delta');
    expect(ctx.storage.put).toHaveBeenCalled();
  });

  it('returns early when hard-stopped before processing page', async () => {
    const connector: MailboxConnector = {
      fetch_delta: vi
        .fn()
        .mockImplementation(
          async (
            _t,
            _m,
            _folder,
            _prev,
            on_page?: (p: number, n: number, m: MailMessage[]) => unknown,
          ) => {
            if (on_page) {
              const go = await on_page(1, 0, []);
              expect(go).toBe(false);
            }
            return {
              messages: [],
              removed_ids: [],
              delta_link: 'd',
              delta_reset: false,
            };
          },
        ),
    } as unknown as MailboxConnector;

    const ctx = {
      tenant_id: 't',
      storage: {
        exists: vi.fn(),
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        delete_version: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn(),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    const progress: BackupProgressReporter = {
      set_status: vi.fn(),
      mark_active: vi.fn(),
      update_active: vi.fn(),
      update_paging: vi.fn(),
      mark_done: vi.fn(),
      mark_all_pending_interrupted: vi.fn(),
      mark_error: vi.fn(),
      update_total: vi.fn(),
      finish: vi.fn(),
    };

    await sync_single_folder({
      ctx,
      connector,
      tenant_id: 't',
      mailbox_id: 'm',
      folder_id: 'f',
      folder_index: 0,
      folder_total: 1,
      global_total: 1,
      global_processed_before: 0,
      sync_start: Date.now(),
      progress,
      is_interrupted: () => false,
      is_hard_stopped: () => true,
    });
  });
});
