import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type {
  BackupProgressReporter,
  MailMessage,
  MailboxConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';

/**
 * Issue #366. The per-folder attachment flush used a bare `Promise.all`, so one failing fetch
 * rejected the batch, the throw left `sync_single_folder`, and the mailbox sync recorded a
 * folder-level error that discarded every entry already processed in that folder. Those blobs
 * were already in storage, so they became orphans. A message deleted between the delta page and
 * the attachment fetch is enough to trigger it.
 */

function make_message(message_id: string): MailMessage {
  return {
    message_id,
    subject: 'Example subject',
    has_attachments: true,
    received_at: '2026-08-17T00:00:00.000Z',
    raw_body: Buffer.from(`body-${message_id}`),
  } as unknown as MailMessage;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_progress(): BackupProgressReporter {
  return {
    mark_active: vi.fn(),
    mark_done: vi.fn(),
    mark_error: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    finish: vi.fn(),
  } as unknown as BackupProgressReporter;
}

/** MIME capture off, so every message with attachments goes through the pending flush. */
function make_connector(fail_for: (message_id: string) => Error | undefined): MailboxConnector {
  return {
    fetch_delta: vi.fn().mockResolvedValue({
      messages: [make_message('msg-1'), make_message('msg-2'), make_message('msg-3')],
      delta_link: 'delta-2',
    }),
    fetch_mime: vi.fn().mockRejectedValue(new Error('not available')),
    fetch_attachments: vi.fn(async (_t: string, _o: string, message_id: string) => {
      const failure = fail_for(message_id);
      if (failure) throw failure;
      return [
        {
          attachment_id: `att-${message_id}`,
          name: 'Report.docx',
          content_type: 'application/vnd.openxmlformats',
          size_bytes: 4,
          content: Buffer.from('abcd'),
          is_inline: false,
        },
      ];
    }),
  } as unknown as MailboxConnector;
}

async function run(
  fail_for: (message_id: string) => Error | undefined,
  is_interrupted: () => boolean = () => false,
): ReturnType<typeof sync_single_folder> {
  return sync_single_folder({
    ctx: make_ctx(),
    connector: make_connector(fail_for),
    tenant_id: 'tenant-1',
    owner_id: 'john.doe@example.com',
    folder_id: 'inbox',
    folder_index: 0,
    folder_total: 3,
    global_total: 3,
    global_processed_before: 0,
    sync_start: Date.now(),
    progress: make_progress(),
    is_interrupted,
    is_hard_stopped: () => false,
    operation_control: {},
    previous_manifest_entries: 0,
  });
}

describe('one attachment fetch failing during a folder flush', () => {
  it('keeps the folder entries and records the message', async () => {
    const result = await run((id) => (id === 'msg-2' ? new Error('ErrorItemNotFound') : undefined));

    expect(result.entries).toHaveLength(3);
    expect(result.attachment_errors).toHaveLength(1);
    expect(result.attachment_errors[0]).toContain('msg-2');
    // The other two still carry their attachments.
    expect(result.attachments_stored).toBe(2);
  });

  it('still stops the run for a permission failure', async () => {
    await expect(
      run((id) => (id === 'msg-2' ? new AuthError('403 from Graph') : undefined)),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('records nothing when every fetch succeeds', async () => {
    const result = await run(() => undefined);

    expect(result.attachment_errors).toEqual([]);
    expect(result.attachments_stored).toBe(3);
  });

  it('stops scheduling attachment fetches once the run is interrupted', async () => {
    const result = await run(
      () => undefined,
      () => true,
    );

    expect(result.attachments_stored).toBe(0);
  });
});
