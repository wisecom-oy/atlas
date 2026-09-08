import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  MailboxConnector,
  ManifestEntry,
  RestoreConnector,
  TenantContext,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import {
  restore_folder_entries,
  restore_single_message,
} from '@/services/restore/restore-execution-orchestrator';

/**
 * Issue #341: the caller of the attachment writer read only its success count, so an attachment
 * whose GCM tag failed produced `restored: 1, attachments: 0, errors: []`. That is the same result
 * a message with no attachments produces, and the run exited clean.
 */

const MESSAGE = Buffer.from(JSON.stringify({ subject: 'Quarterly report', parentFolderId: 'f1' }));
const ATTACHMENT = Buffer.from('attachment-bytes');
const CORRUPT_KEY = 'attachments/user/corrupt';

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function make_entry(): ManifestEntry {
  return {
    object_id: 'msg-1',
    storage_key: 'data/user/msg-1',
    checksum: sha(MESSAGE),
    size_bytes: MESSAGE.length,
    folder_id: 'f1',
    attachments: [
      {
        attachment_id: 'att-1',
        name: 'report.pdf',
        content_type: 'application/pdf',
        size_bytes: ATTACHMENT.length,
        storage_key: CORRUPT_KEY,
        checksum: sha(ATTACHMENT),
        is_inline: false,
      },
    ],
  };
}

/** Storage serves the message; the attachment object fails to authenticate. */
function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn(async (key: string) => Buffer.from(key)), put: vi.fn() },
    encrypt: (data: Buffer) => data,
    decrypt: vi.fn((data: Buffer) => {
      if (data.toString() === CORRUPT_KEY) {
        throw new Error('Unsupported state or unable to authenticate data');
      }
      return MESSAGE;
    }),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_restore_connector(): RestoreConnector {
  return {
    create_mail_folder: vi.fn().mockResolvedValue('folder-1'),
    create_message: vi.fn().mockResolvedValue('new-msg-1'),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
    list_folder_messages: vi.fn(),
  };
}

function make_dashboard(): TransferProgressReporter {
  return {
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    finish: vi.fn(),
  } as unknown as TransferProgressReporter;
}

describe('an attachment that fails to authenticate (issue #341)', () => {
  it('is reported by the folder restore rather than counted as a message with none', async () => {
    const connector = make_restore_connector();

    const result = await restore_folder_entries(
      make_ctx(),
      connector,
      'tenant-1',
      'user@test.com',
      'target-folder',
      [make_entry()],
      0,
      0,
      1,
      Date.now(),
      make_dashboard(),
      () => false,
      {},
    );

    // The message did land, so it counts as restored. What must not happen is the failure
    // vanishing: zero attachments and an empty error list reads as a message that had none.
    expect(result.restored).toBe(1);
    expect(result.attachments).toBe(0);
    expect(result.attachment_errors).toHaveLength(1);
    expect(result.attachment_errors[0]).toContain('report.pdf');
    expect(connector.add_attachment).not.toHaveBeenCalled();
  });

  it('is counted in the result of a single-message restore', async () => {
    const connector = make_restore_connector();
    const mailbox: MailboxConnector = {
      list_mail_folders: vi.fn().mockResolvedValue([]),
    } as unknown as MailboxConnector;

    const result = await restore_single_message(
      make_ctx(),
      mailbox,
      connector,
      'tenant-1',
      'user@test.com',
      'user@test.com',
      'snap-1',
      make_entry(),
    );

    expect(result.restored_count).toBe(1);
    expect(result.attachment_count).toBe(0);
    expect(result.attachment_error_count).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});
