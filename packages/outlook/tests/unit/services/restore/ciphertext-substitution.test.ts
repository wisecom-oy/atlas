import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AttachmentEntry,
  ManifestEntry,
  RestoreConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { restore_one_entry } from '@/services/restore/restore-execution-orchestrator';
import { restore_entry_attachments } from '@/services/restore/restore-attachment-writer';

/**
 * Issue #340: content is encrypted with one tenant key and nothing in the ciphertext says which
 * object it belongs to, so any object in the tenant authenticates in any other object's place.
 * Swapping two blobs needs write access to the bucket, not the key. The manifest checksum is the
 * only thing that distinguishes them, and it has to be checked before the Graph call, not after.
 */

const MESSAGE_A = Buffer.from(JSON.stringify({ subject: 'Message A', parentFolderId: 'f1' }));
const MESSAGE_B = Buffer.from(JSON.stringify({ subject: 'Message B', parentFolderId: 'f1' }));
const ATTACHMENT_A = Buffer.from('attachment-a-bytes');
const ATTACHMENT_B = Buffer.from('attachment-b-bytes');

function sha(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Stores plaintext directly; `decrypt` is the identity, so every stored blob authenticates. */
function make_ctx(objects: Record<string, Buffer>): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      get: vi.fn(async (key: string) => objects[key] ?? Buffer.alloc(0)),
      put: vi.fn(),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_restore_connector(): RestoreConnector {
  return {
    create_mail_folder: vi.fn(),
    create_message: vi.fn().mockResolvedValue('new-msg-1'),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
    list_folder_messages: vi.fn(),
  };
}

function make_entry(checksum: string): ManifestEntry {
  return {
    object_id: 'msg-a',
    storage_key: 'data/user/msg-a',
    checksum,
    size_bytes: MESSAGE_A.length,
    folder_id: 'f1',
  };
}

function make_attachment(checksum: string): AttachmentEntry {
  return {
    attachment_id: 'att-a',
    name: 'report.pdf',
    content_type: 'application/pdf',
    size_bytes: ATTACHMENT_A.length,
    storage_key: 'attachments/user/att-a',
    checksum,
    is_inline: false,
  };
}

describe('Outlook restore under ciphertext substitution (issue #340)', () => {
  it('restores the message when the stored bytes are the ones the manifest recorded', async () => {
    const ctx = make_ctx({ 'data/user/msg-a': MESSAGE_A });
    const connector = make_restore_connector();

    await restore_one_entry(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'f1',
      make_entry(sha(MESSAGE_A)),
    );

    expect(connector.create_message).toHaveBeenCalledTimes(1);
  });

  it('creates no message when another message was written over the blob', async () => {
    // Message B's ciphertext under message A's key: it decrypts and authenticates, and before the
    // fix it reached create_message as message A.
    const ctx = make_ctx({ 'data/user/msg-a': MESSAGE_B });
    const connector = make_restore_connector();

    await expect(
      restore_one_entry(
        ctx,
        connector,
        'tenant-1',
        'user@test.com',
        'f1',
        make_entry(sha(MESSAGE_A)),
      ),
    ).rejects.toThrow(/does not match its manifest checksum/);

    expect(connector.create_message).not.toHaveBeenCalled();
  });

  it('refuses an entry that records no checksum, since nothing can distinguish it', async () => {
    const ctx = make_ctx({ 'data/user/msg-a': MESSAGE_B });
    const connector = make_restore_connector();

    await expect(
      restore_one_entry(ctx, connector, 'tenant-1', 'user@test.com', 'f1', make_entry('')),
    ).rejects.toThrow(/does not match its manifest checksum/);

    expect(connector.create_message).not.toHaveBeenCalled();
  });

  it('uploads no attachment when another attachment was written over the blob', async () => {
    const ctx = make_ctx({ 'attachments/user/att-a': ATTACHMENT_B });
    const connector = make_restore_connector();

    const result = await restore_entry_attachments(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'new-msg-1',
      [make_attachment(sha(ATTACHMENT_A))],
    );

    expect(connector.add_attachment).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.errors[0]).toMatch(/does not match its manifest checksum/);
  });
});
