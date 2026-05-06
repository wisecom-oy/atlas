import { describe, it, expect, vi } from 'vitest';
import { fetch_and_store_attachments } from '@/services/backup/attachment-storage-sync';
import type { MailboxConnector, TenantContext, ObjectStorage } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_mock_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
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
    create_cipher: stub_tenant_create_cipher,
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
