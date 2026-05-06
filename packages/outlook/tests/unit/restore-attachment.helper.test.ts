import { describe, it, expect, vi, beforeEach } from 'vitest';
import { restore_entry_attachments } from '@/services/restore/restore-attachment-writer';
import type { TenantContext } from '@atlas/types';
import type { RestoreConnector } from '@atlas/types';
import type { AttachmentEntry } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_ctx(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(Buffer.from('Econtent')),
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
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      probe_immutability: vi.fn(),
    },
    encrypt: vi.fn(),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
  };
}

function make_restore_connector(): RestoreConnector {
  return {
    create_mail_folder: vi.fn(),
    create_message: vi.fn(),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
  };
}

function make_attachment(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachment_id: 'att-1',
    name: 'report.pdf',
    content_type: 'application/pdf',
    size_bytes: 1024,
    storage_key: 'attachments/user/sha256hash',
    checksum: 'sha256hash',
    is_inline: false,
    ...overrides,
  };
}

describe('restore_entry_attachments', () => {
  let ctx: TenantContext;
  let connector: RestoreConnector;

  beforeEach(() => {
    ctx = make_ctx();
    connector = make_restore_connector();
  });

  it('restores a small attachment', async () => {
    const att = make_attachment();
    const result = await restore_entry_attachments(
      ctx,
      connector,
      'tenant',
      'user@test.com',
      'new-msg-1',
      [att],
    );

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(ctx.storage.get).toHaveBeenCalledWith('attachments/user/sha256hash');
    expect(ctx.decrypt).toHaveBeenCalled();
    expect(connector.add_attachment).toHaveBeenCalledWith(
      'tenant',
      'user@test.com',
      'new-msg-1',
      expect.objectContaining({ name: 'report.pdf', content_type: 'application/pdf' }),
    );
  });

  it('skips attachments without storage_key', async () => {
    const att = make_attachment({ storage_key: '', checksum: '' });
    const result = await restore_entry_attachments(
      ctx,
      connector,
      'tenant',
      'user@test.com',
      'new-msg-1',
      [att],
    );

    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(ctx.storage.get).not.toHaveBeenCalled();
    expect(connector.add_attachment).not.toHaveBeenCalled();
  });

  it('collects errors without aborting', async () => {
    (connector.add_attachment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('upload failed'),
    );

    const result = await restore_entry_attachments(
      ctx,
      connector,
      'tenant',
      'user@test.com',
      'new-msg-1',
      [make_attachment(), make_attachment({ attachment_id: 'att-2', name: 'photo.jpg' })],
    );

    expect(result.restored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('report.pdf');
  });

  it('passes content_id through to AttachmentUpload', async () => {
    const att = make_attachment({
      is_inline: true,
      content_id: 'image001.png@01DA3B2F.5A7E8990',
    });

    await restore_entry_attachments(ctx, connector, 'tenant', 'user@test.com', 'msg-1', [att]);

    expect(connector.add_attachment).toHaveBeenCalledWith(
      'tenant',
      'user@test.com',
      'msg-1',
      expect.objectContaining({ content_id: 'image001.png@01DA3B2F.5A7E8990' }),
    );
  });

  it('handles multiple attachments', async () => {
    const atts = [
      make_attachment({ attachment_id: 'a1', name: 'file1.pdf' }),
      make_attachment({ attachment_id: 'a2', name: 'file2.docx' }),
    ];

    const result = await restore_entry_attachments(
      ctx,
      connector,
      'tenant',
      'user@test.com',
      'msg-1',
      atts,
    );

    expect(result.restored).toBe(2);
    expect(connector.add_attachment).toHaveBeenCalledTimes(2);
  });
});
