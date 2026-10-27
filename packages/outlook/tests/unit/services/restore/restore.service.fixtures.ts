import { vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { RestoreService } from '@/services/restore/restore.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  MailFolder,
  ManifestRepository,
  RestoreConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';
import { createHash } from 'node:crypto';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';

/** Builds a minimal Outlook manifest entry for restore service tests. */
export function make_restore_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: STORED_PAYLOAD_CHECKSUM,
    size_bytes: 100,
    subject: `Subject ${id}`,
    folder_id,
  };
}

/** Builds a minimal Outlook manifest for restore service tests. */
export function make_restore_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

/** Builds the encrypted-message fixture consumed by the restore service tests. */
export function make_stored_message(folder_id: string): Buffer {
  const json = JSON.stringify({
    subject: 'Hello',
    body: { contentType: 'Text', content: 'Hello world' },
    parentFolderId: folder_id,
    receivedDateTime: '2026-01-01T00:00:00Z',
    isRead: true,
  });
  return Buffer.concat([Buffer.from('E'), Buffer.from(json)]);
}

/**
 * SHA-256 of the plaintext the stubbed storage hands back for every key.
 *
 * Restore verifies decrypted bytes against the entry's checksum before it calls Graph (issue
 * #340), so a fixture entry has to carry the digest of what the stub actually stores rather than
 * an arbitrary string.
 */
export const STORED_PAYLOAD_CHECKSUM = createHash('sha256')
  .update(make_stored_message('f1').subarray(1))
  .digest('hex');

/** The service under test and the port mocks it was built with. */
export interface RestoreHarness {
  readonly service: RestoreService;
  readonly mock_context: TenantContext;
  readonly mock_manifests: ManifestRepository;
  readonly mock_connector: MailboxConnector;
  readonly mock_restore: RestoreConnector;
}

/** Builds a RestoreService wired to fresh port mocks; one per test. */
export function make_restore_harness(): RestoreHarness {
  const mock_context: TenantContext = {
    tenant_id: 'test-tenant',
    storage: {
      put: vi.fn(),
      get: vi.fn().mockImplementation(() => Promise.resolve(make_stored_message('f1'))),
      delete: vi.fn(),
      delete_version: vi.fn(),
      exists: vi.fn(),
      list_stale: vi.fn(async () => []),
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
    create_content_hmac: stub_tenant_create_content_hmac,
    create_decipher: stub_tenant_create_decipher,
    destroy: vi.fn(),
  };

  const mock_manifests: ManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn(),
    find_latest_by_owner: vi.fn(),
    list_by_owner: vi.fn().mockResolvedValue([]),
    list_all_manifests: vi.fn().mockResolvedValue([]),
    list_owner_ids: vi.fn().mockResolvedValue([]),
  };

  const folders: MailFolder[] = [
    { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 10 },
    { folder_id: 'f2', display_name: 'Sent', folder_path: 'Sent', total_item_count: 5 },
  ];

  const mock_connector: MailboxConnector = {
    list_mailboxes: vi.fn(),
    mailbox_exists: vi.fn().mockResolvedValue(true),
    list_mail_folders: vi.fn().mockResolvedValue(folders),
    fetch_delta: vi.fn(),
    fetch_message: vi.fn(),
    fetch_attachments: vi.fn(),
  };

  const mock_restore: RestoreConnector = {
    create_mail_folder: vi.fn().mockResolvedValue({
      folder_id: 'restore-root',
      display_name: 'Restore-2026-03-08',
      folder_path: 'Restore-2026-03-08',
      total_item_count: 0,
    }),
    create_message: vi.fn().mockResolvedValue('new-msg-id'),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn().mockResolvedValue(0),
    list_folder_messages: vi.fn().mockResolvedValue([]),
  };

  const container: Container = new Container();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
    create: vi.fn().mockResolvedValue(mock_context),
    create_readonly: vi.fn().mockResolvedValue(mock_context),
    create_storage_only: vi.fn().mockResolvedValue(mock_context),
  } as unknown as TenantContextFactory);
  container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
  container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
  container.bind(RESTORE_CONNECTOR_TOKEN).toConstantValue(mock_restore);
  container.bind(RestoreService).toSelf();

  return {
    service: container.get(RestoreService),
    mock_context,
    mock_manifests,
    mock_connector,
    mock_restore,
  };
}
