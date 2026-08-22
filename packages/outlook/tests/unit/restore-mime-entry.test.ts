import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  restore_one_entry,
  restore_single_message,
} from '@/services/restore/restore-execution-orchestrator';
import type { MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';

const ATTACHMENT_BYTES = Buffer.from('col_a,col_b\n1,2\n', 'utf-8');
const JSON_ATTACHMENT_BYTES = Buffer.from('stored-attachment-bytes', 'utf-8');

/** RFC 5322 blob as backup stores it for a `payload_format: 'mime'` entry. */
function build_stored_mime(): Buffer {
  return Buffer.from(
    [
      'Received: from EXCH02.corp.example.com by MAIL01.corp.example.com;',
      '\tTue, 4 Mar 2025 09:15:04 +0000',
      'From: "Nora Partner" <nora@partner.example>',
      'To: "Atlas Admin" <admin@corp.example.com>',
      'Cc: "Audit Log" <audit@corp.example.com>',
      'Subject: Q1 reconciliation figures',
      'Date: Tue, 4 Mar 2025 09:14:58 +0000',
      'Message-ID: <thread-root-9f21@partner.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<html><body><p>Figures attached.</p></body></html>',
      '',
      '--OUTER',
      'Content-Type: text/csv; name="q1.csv"',
      'Content-Disposition: attachment; filename="q1.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      ATTACHMENT_BYTES.toString('base64'),
      '',
      '--OUTER--',
      '',
    ].join('\r\n'),
    'utf-8',
  );
}

/** Legacy Graph JSON blob, still the format for entries without payload_format. */
function build_stored_json(): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'graph-id',
      subject: 'Legacy JSON message',
      body: { contentType: 'html', content: '<p>legacy</p>' },
      toRecipients: [{ emailAddress: { name: 'Admin', address: 'admin@corp.example.com' } }],
      parentFolderId: 'f1',
      receivedDateTime: '2024-06-01T10:00:00Z',
      isRead: true,
    }),
    'utf-8',
  );
}

const MIME_ENTRY: ManifestEntry = {
  object_id: 'msg-mime',
  storage_key: 'data/user/mime-blob',
  checksum: 'chk-mime',
  size_bytes: 2048,
  subject: 'Q1 reconciliation figures',
  folder_id: 'f1',
  payload_format: 'mime',
  received_at: '2025-03-04T09:14:58.000Z',
};

const JSON_ENTRY: ManifestEntry = {
  object_id: 'msg-json',
  storage_key: 'data/user/json-blob',
  checksum: 'chk-json',
  size_bytes: 512,
  subject: 'Legacy JSON message',
  folder_id: 'f1',
  attachments: [
    {
      attachment_id: 'att-1',
      name: 'legacy.txt',
      content_type: 'text/plain',
      checksum: 'chk-att-1',
      size_bytes: JSON_ATTACHMENT_BYTES.length,
      is_inline: false,
      storage_key: 'data/user/att-blob',
    },
  ],
};

describe('restore of MIME and legacy JSON entries', () => {
  let ctx: TenantContext;
  let restore_connector: RestoreConnector;
  let connector: MailboxConnector;

  /** Encryption is a 1-byte prefix, matching the other restore unit tests. */
  function encrypted(plain: Buffer): Buffer {
    return Buffer.concat([Buffer.from('E'), plain]);
  }

  beforeEach(() => {
    const blobs: Record<string, Buffer> = {
      'data/user/mime-blob': encrypted(build_stored_mime()),
      'data/user/json-blob': encrypted(build_stored_json()),
      'data/user/att-blob': encrypted(JSON_ATTACHMENT_BYTES),
    };

    ctx = {
      tenant_id: 'test-tenant',
      storage: {
        put: vi.fn(),
        get: vi.fn((key: string) => Promise.resolve(blobs[key] ?? Buffer.alloc(0))),
        delete: vi.fn(),
        delete_version: vi.fn(),
        exists: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn().mockResolvedValue([]),
        begin_multipart_upload: vi.fn().mockResolvedValue({
          upload_part: vi.fn(),
          complete: vi.fn(),
          abort: vi.fn(),
        }),
        copy: vi.fn(),
        get_with_etag: vi.fn(),
        get_stream: vi.fn(),
        apply_default_retention: vi.fn(),
        abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn(),
      decrypt: vi.fn((data: Buffer) => data.subarray(1)),
      create_cipher: stub_tenant_create_cipher,
      create_decipher: stub_tenant_create_decipher,
      destroy: vi.fn(),
    };

    restore_connector = {
      create_mail_folder: vi.fn().mockImplementation((_t, _o, display_name: string) =>
        Promise.resolve({
          folder_id: display_name === 'Inbox' ? 'restore-inbox' : 'restore-root',
          display_name,
          folder_path: display_name,
          total_item_count: 0,
        } satisfies MailFolder),
      ),
      create_message: vi.fn().mockResolvedValue('new-msg-id'),
      add_attachment: vi.fn(),
      create_upload_session: vi.fn(),
      upload_attachment_chunk: vi.fn(),
      count_folder_messages: vi.fn().mockResolvedValue(0),
      list_folder_messages: vi.fn().mockResolvedValue([]),
    };

    connector = {
      list_mailboxes: vi.fn(),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi
        .fn()
        .mockResolvedValue([
          { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 10 },
        ] satisfies MailFolder[]),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn(),
    };
  });

  it('creates a MIME entry as a non-draft message from the parsed MIME', async () => {
    const result = await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      MIME_ENTRY,
    );

    expect(restore_connector.create_message).toHaveBeenCalledTimes(1);
    const [tenant, owner, folder, payload] = vi.mocked(restore_connector.create_message).mock
      .calls[0]!;
    expect(tenant).toBe('test-tenant');
    expect(owner).toBe('target@corp.example.com');
    expect(folder).toBe('target-folder');

    expect(payload['isDraft']).toBe(false);
    expect(payload['subject']).toBe('Q1 reconciliation figures');
    expect(payload['body']).toEqual({
      contentType: 'html',
      content: expect.stringContaining('<p>Figures attached.</p>'),
    });
    expect(payload['from']).toEqual({
      emailAddress: { name: 'Nora Partner', address: 'nora@partner.example' },
    });
    expect(payload['toRecipients']).toEqual([
      { emailAddress: { name: 'Atlas Admin', address: 'admin@corp.example.com' } },
    ]);
    expect(payload['ccRecipients']).toEqual([
      { emailAddress: { name: 'Audit Log', address: 'audit@corp.example.com' } },
    ]);
    expect(payload['internetMessageId']).toBe('<thread-root-9f21@partner.example>');
    expect(result.att).toBe(1);
  });

  it('derives the MAPI delivery and submit times from the MIME Date header', async () => {
    await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      MIME_ENTRY,
    );

    const payload = vi.mocked(restore_connector.create_message).mock.calls[0]![3];
    expect(payload['singleValueExtendedProperties']).toEqual([
      { id: 'Integer 0x0E07', value: '1' },
      { id: 'SystemTime 0x0E06', value: '2025-03-04T09:14:58.000Z' },
      { id: 'SystemTime 0x0039', value: '2025-03-04T09:14:58.000Z' },
    ]);
  });

  it('uploads attachments parsed out of the MIME with the exact bytes', async () => {
    await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      MIME_ENTRY,
    );

    expect(restore_connector.add_attachment).toHaveBeenCalledTimes(1);
    const [, , message_id, upload] = vi.mocked(restore_connector.add_attachment).mock.calls[0]!;
    expect(message_id).toBe('new-msg-id');
    expect(upload.name).toBe('q1.csv');
    expect(upload.content_type).toBe('text/csv');
    expect(upload.is_inline).toBe(false);
    expect(upload.content.equals(ATTACHMENT_BYTES)).toBe(true);
  });

  it('never reads a separate attachment blob for a MIME entry', async () => {
    await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      MIME_ENTRY,
    );

    expect(ctx.storage.get).toHaveBeenCalledTimes(1);
    expect(ctx.storage.get).toHaveBeenCalledWith('data/user/mime-blob');
  });

  it('still restores a legacy JSON entry through the sanitized JSON path', async () => {
    const result = await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      JSON_ENTRY,
    );

    const payload = vi.mocked(restore_connector.create_message).mock.calls[0]![3];
    // sanitize_message_for_restore strips read-only Graph fields and forces isDraft.
    expect(payload['id']).toBeUndefined();
    expect(payload['parentFolderId']).toBeUndefined();
    expect(payload['isDraft']).toBe(false);
    expect(payload['subject']).toBe('Legacy JSON message');
    expect(payload['singleValueExtendedProperties']).toEqual([
      { id: 'Integer 0x0E07', value: '1' },
      { id: 'SystemTime 0x0E06', value: '2024-06-01T10:00:00Z' },
    ]);
    expect(result.att).toBe(1);
  });

  it('restores legacy JSON attachments from their own storage blob', async () => {
    await restore_one_entry(
      ctx,
      restore_connector,
      'test-tenant',
      'target@corp.example.com',
      'target-folder',
      JSON_ENTRY,
    );

    expect(ctx.storage.get).toHaveBeenCalledWith('data/user/json-blob');
    expect(ctx.storage.get).toHaveBeenCalledWith('data/user/att-blob');

    const [, , , upload] = vi.mocked(restore_connector.add_attachment).mock.calls[0]!;
    expect(upload.name).toBe('legacy.txt');
    expect(upload.content.equals(JSON_ATTACHMENT_BYTES)).toBe(true);
  });

  it('resolves the MIME entry folder from the manifest without parsing the blob', async () => {
    const result = await restore_single_message(
      ctx,
      connector,
      restore_connector,
      'test-tenant',
      'source@corp.example.com',
      'target@corp.example.com',
      'snap-1',
      MIME_ENTRY,
    );

    expect(restore_connector.create_mail_folder).toHaveBeenCalledWith(
      'test-tenant',
      'target@corp.example.com',
      'Inbox',
      'restore-root',
    );
    expect(vi.mocked(restore_connector.create_message).mock.calls[0]![2]).toBe('restore-inbox');
    // One decrypt only: the MIME blob. The folder came from entry.folder_id.
    expect(ctx.storage.get).toHaveBeenCalledTimes(1);
    expect(result.restored_count).toBe(1);
    expect(result.attachment_count).toBe(1);
  });
});
