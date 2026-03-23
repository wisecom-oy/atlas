import { describe, it, expect, vi } from 'vitest';
import { fetch_and_store_attachments } from '@/services/backup/attachment-storage-sync';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

function make_mock_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    probe_immutability: vi.fn().mockResolvedValue({
      bucket: 'test-bucket',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    }),
  };
}

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
  };
}

function make_mock_connector(attachments: unknown[]): MailboxConnector {
  return {
    list_mailboxes: vi.fn(),
    list_mail_folders: vi.fn(),
    fetch_delta: vi.fn(),
    fetch_message: vi.fn(),
    fetch_attachments: vi.fn().mockResolvedValue(attachments),
  };
}

describe('fetch_and_store_attachments – on_progress callback', () => {
  it('calls on_progress with (done, total) for each attachment', async () => {
    const ctx = make_mock_context();
    const connector = make_mock_connector([
      {
        attachment_id: 'a1',
        name: 'file1.txt',
        content_type: 'text/plain',
        size_bytes: 10,
        is_inline: false,
        content: Buffer.from('aaa'),
        content_id: '',
      },
      {
        attachment_id: 'a2',
        name: 'file2.txt',
        content_type: 'text/plain',
        size_bytes: 20,
        is_inline: false,
        content: Buffer.from('bbb'),
        content_id: '',
      },
      {
        attachment_id: 'a3',
        name: 'file3.txt',
        content_type: 'text/plain',
        size_bytes: 30,
        is_inline: false,
        content: Buffer.from('ccc'),
        content_id: '',
      },
    ]);

    const progress_calls: [number, number][] = [];
    const on_progress = (done: number, total: number): void => {
      progress_calls.push([done, total]);
    };

    const entries = await fetch_and_store_attachments(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'msg-1',
      on_progress,
    );

    expect(entries).toHaveLength(3);
    expect(progress_calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('does not fail when on_progress is not provided', async () => {
    const ctx = make_mock_context();
    const connector = make_mock_connector([
      {
        attachment_id: 'a1',
        name: 'file.txt',
        content_type: 'text/plain',
        size_bytes: 5,
        is_inline: false,
        content: Buffer.from('x'),
        content_id: '',
      },
    ]);

    const entries = await fetch_and_store_attachments(
      ctx,
      connector,
      'tenant-1',
      'user@test.com',
      'msg-1',
    );

    expect(entries).toHaveLength(1);
  });
});
