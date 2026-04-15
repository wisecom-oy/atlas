import { describe, it, expect, vi } from 'vitest';
import {
  sanitize_message_for_restore,
  extract_folder_id_from_json,
  decrypt_and_parse_message,
} from '@/services/restore/restore-message-transformer';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ManifestEntry } from '@/domain/manifest';

function make_graph_message(): Record<string, unknown> {
  return {
    id: 'AAMkAbc123',
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users...',
    '@odata.etag': 'W/"ETAG"',
    subject: 'Test Subject',
    body: { contentType: 'HTML', content: '<p>Hello</p>' },
    from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
    toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: '2026-03-01T10:00:00Z',
    sentDateTime: '2026-03-01T09:59:00Z',
    importance: 'normal',
    isRead: true,
    isDraft: false,
    flag: { flagStatus: 'notFlagged' },
    categories: [],
    internetMessageId: '<msg123@test.com>',
    parentFolderId: 'folder-abc',
    createdDateTime: '2026-03-01T10:00:01Z',
    lastModifiedDateTime: '2026-03-01T10:00:02Z',
    changeKey: 'CK123',
    conversationId: 'conv-456',
    webLink: 'https://outlook.office.com/...',
    bodyPreview: 'Hello',
    hasAttachments: false,
  };
}

describe('sanitize_message_for_restore', () => {
  it('strips read-only and OData fields', () => {
    const result = sanitize_message_for_restore(make_graph_message());

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('@odata.context');
    expect(result).not.toHaveProperty('@odata.etag');
    expect(result).not.toHaveProperty('createdDateTime');
    expect(result).not.toHaveProperty('lastModifiedDateTime');
    expect(result).not.toHaveProperty('changeKey');
    expect(result).not.toHaveProperty('conversationId');
    expect(result).not.toHaveProperty('webLink');
    expect(result).not.toHaveProperty('bodyPreview');
    expect(result).not.toHaveProperty('parentFolderId');
    expect(result).not.toHaveProperty('hasAttachments');
  });

  it('keeps writable fields', () => {
    const result = sanitize_message_for_restore(make_graph_message());

    expect(result.subject).toBe('Test Subject');
    expect(result.body).toEqual({ contentType: 'HTML', content: '<p>Hello</p>' });
    expect(result.from).toBeDefined();
    expect(result.toRecipients).toBeDefined();
    expect(result.receivedDateTime).toBe('2026-03-01T10:00:00Z');
    expect(result.importance).toBe('normal');
    expect(result.isRead).toBe(true);
    expect(result.flag).toBeDefined();
    expect(result.categories).toBeDefined();
    expect(result.internetMessageId).toBe('<msg123@test.com>');
  });

  it('forces isDraft to false', () => {
    const msg = make_graph_message();
    msg.isDraft = true;
    const result = sanitize_message_for_restore(msg);
    expect(result.isDraft).toBe(false);
  });

  it('sets PR_MESSAGE_FLAGS to 1 (read, non-draft) for read messages', () => {
    const msg = make_graph_message();
    msg.isRead = true;
    const result = sanitize_message_for_restore(msg);
    const props = result.singleValueExtendedProperties as { id: string; value: string }[];
    expect(props).toContainEqual({ id: 'Integer 0x0E07', value: '1' });
  });

  it('sets PR_MESSAGE_FLAGS to 0 (unread, non-draft) for unread messages', () => {
    const msg = make_graph_message();
    msg.isRead = false;
    const result = sanitize_message_for_restore(msg);
    const props = result.singleValueExtendedProperties as { id: string; value: string }[];
    expect(props).toContainEqual({ id: 'Integer 0x0E07', value: '0' });
  });

  it('preserves original receivedDateTime via MAPI PR_MESSAGE_DELIVERY_TIME', () => {
    const result = sanitize_message_for_restore(make_graph_message());
    const props = result.singleValueExtendedProperties as { id: string; value: string }[];
    expect(props).toContainEqual({
      id: 'SystemTime 0x0E06',
      value: '2026-03-01T10:00:00Z',
    });
  });

  it('preserves original sentDateTime via MAPI PR_CLIENT_SUBMIT_TIME', () => {
    const result = sanitize_message_for_restore(make_graph_message());
    const props = result.singleValueExtendedProperties as { id: string; value: string }[];
    expect(props).toContainEqual({
      id: 'SystemTime 0x0039',
      value: '2026-03-01T09:59:00Z',
    });
  });
});

describe('extract_folder_id_from_json', () => {
  it('returns parentFolderId from message JSON', () => {
    expect(extract_folder_id_from_json(make_graph_message())).toBe('folder-abc');
  });

  it('returns __unknown__ when parentFolderId is missing', () => {
    expect(extract_folder_id_from_json({})).toBe('__unknown__');
  });
});

describe('decrypt_and_parse_message', () => {
  function make_ctx_and_entry(
    plaintext: Buffer,
    checksum: string,
  ): { ctx: TenantContext; entry: ManifestEntry } {
    const encrypted = Buffer.concat([Buffer.from('E'), plaintext]);
    const ctx: TenantContext = {
      tenant_id: 'test',
      storage: {
        put: vi.fn(),
        get: vi.fn().mockResolvedValue(encrypted),
        delete: vi.fn(),
        delete_version: vi.fn(),
        exists: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn().mockResolvedValue([]),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn(),
      decrypt: vi.fn((data: Buffer) => data.subarray(1)),
      destroy: vi.fn(),
    };
    const entry: ManifestEntry = {
      object_id: 'msg-1',
      storage_key: 'data/user/abc123',
      checksum,
      size_bytes: 100,
    };
    return { ctx, entry };
  }

  it('decrypts and parses the stored JSON blob', async () => {
    const original = { subject: 'Hello', parentFolderId: 'f1' };
    const plaintext = Buffer.from(JSON.stringify(original));
    const checksum = 'b47ebd52b6041ef677d6847c6e6bb0a8400442ad3750d5419b9ec20bffda0659';
    const { ctx, entry } = make_ctx_and_entry(plaintext, checksum);

    const result = await decrypt_and_parse_message(ctx, entry);
    expect(result.subject).toBe('Hello');
    expect(result.parentFolderId).toBe('f1');
    expect(ctx.storage.get).toHaveBeenCalledWith('data/user/abc123');
    expect(ctx.decrypt).toHaveBeenCalled();
  });

  it('throws on checksum mismatch', async () => {
    const plaintext = Buffer.from(JSON.stringify({ subject: 'Hello' }));
    const { ctx, entry } = make_ctx_and_entry(plaintext, 'bad_checksum');

    await expect(decrypt_and_parse_message(ctx, entry)).rejects.toThrow('Checksum mismatch');
  });
});
