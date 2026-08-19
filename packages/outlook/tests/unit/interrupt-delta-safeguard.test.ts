import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  DeltaPageCallback,
  DeltaSyncResult,
  MailboxConnector,
  Manifest,
  MailFolder,
  MailMessage,
  ManifestRepository,
  ObjectStorage,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';

// Regression tests for issue #23: a soft interrupt must never persist a delta
// link that was advanced past unprocessed messages.

function make_message(id: string): MailMessage {
  const raw = Buffer.from(`body-${id}`);
  return {
    message_id: id,
    folder_id: 'folder-1',
    subject: `Subject ${id}`,
    received_at: new Date(),
    size_bytes: raw.length,
    raw_body: raw,
    has_attachments: false,
  };
}

const FOLDER: MailFolder = {
  folder_id: 'folder-1',
  display_name: 'Inbox',
  folder_path: 'Inbox',
  total_item_count: 10,
};

const PREVIOUS_MANIFEST: Manifest = {
  id: 'old-manifest',
  tenant_id: 't',
  owner_id: 'user@test.com',
  snapshot_id: 'old-snap',
  created_at: new Date(),
  total_objects: 0,
  total_size_bytes: 0,
  delta_links: { 'folder-1': 'https://prev-delta' },
  id_format: 'immutable',
  entries: [],
};

/**
 * Simulates the real Graph adapter's paging loop: on_page per page, the
 * deltaLink is captured on the final page BEFORE the should_continue check
 * (mirrors graph-mailbox-connector execute_delta_sync), paging stops when the
 * callback returns false.
 */
function make_streaming_fetch_delta(
  pages: MailMessage[][],
  final_delta_link: string,
  after_page?: (page_num: number) => void,
) {
  return vi.fn(
    async (
      _tenant: string,
      _owner: string,
      _folder: string,
      _prev?: string,
      on_page?: DeltaPageCallback,
    ): Promise<DeltaSyncResult> => {
      let delta_link = '';
      let streamed = 0;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i]!;
        streamed += page.length;
        if (i === pages.length - 1) delta_link = final_delta_link;
        const cont = on_page ? await on_page(i + 1, streamed, page) : true;
        after_page?.(i + 1);
        if (cont === false) break;
      }
      return { messages: [], removed_ids: [], delta_link, delta_reset: false };
    },
  );
}

describe('interrupt delta-link safeguard (issue #23)', () => {
  let storage: ObjectStorage;
  let manifests: ManifestRepository;
  let connector: MailboxConnector;
  let service: MailboxSyncService;

  beforeEach(() => {
    storage = {
      put: vi.fn(),
      get: vi.fn(),
      get_with_etag: vi.fn(),
      get_stream: vi.fn(),
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
        bucket: 'b',
        reachable: true,
        versioning_enabled: true,
        object_lock_enabled: true,
        mode_supported: true,
      }),
    };
    const context: TenantContext = {
      tenant_id: 't',
      storage,
      encrypt: vi.fn((data: Buffer) => data),
      decrypt: vi.fn((data: Buffer) => data),
      create_cipher: stub_tenant_create_cipher,
      create_decipher: vi.fn(),
      destroy: vi.fn(),
    };
    const factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(context),
      create_readonly: vi.fn().mockResolvedValue(context),
      create_storage_only: vi.fn(),
    };
    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(PREVIOUS_MANIFEST),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };
    connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue([FOLDER]),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    const container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(MailboxSyncService).toSelf();
    service = container.get(MailboxSyncService);
  });

  function saved_delta_links(): Record<string, string> {
    const calls = vi.mocked(manifests.save).mock.calls;
    expect(calls.length).toBe(1);
    return calls[0]![1].delta_links;
  }

  it('keeps the previous delta link when interrupted after page 1 of 3', async () => {
    let interrupted = false;
    const pages = [
      [make_message('m1'), make_message('m2')],
      [make_message('m3')],
      [make_message('m4')],
    ];
    connector.fetch_delta = make_streaming_fetch_delta(pages, 'https://new-delta', (page) => {
      if (page === 1) interrupted = true;
    });

    const on_progress = vi.fn();
    const result = await service.sync_mailbox('t', 'user@test.com', {
      should_interrupt: () => interrupted,
      on_progress,
    });

    // page 1 was fully processed (2 unique bodies stored), pages 2-3 never were
    expect(vi.mocked(storage.put).mock.calls.length).toBe(2);
    expect(saved_delta_links()).toEqual({ 'folder-1': 'https://prev-delta' });
    expect(result.interrupted).toBe(true);
    expect(on_progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'backup', workload: 'outlook', phase: 'interrupted' }),
    );
  });

  it('does not persist a delta link captured on an interrupted final page', async () => {
    // Interrupt flips after the first stored message: the single (final) page
    // carries the deltaLink, which the adapter captures before the callback
    // result is evaluated - completeness gating is the only protection here.
    let interrupted = false;
    vi.mocked(storage.put).mockImplementation(async () => {
      interrupted = true;
    });
    const pages = [[make_message('m1'), make_message('m2'), make_message('m3')]];
    connector.fetch_delta = make_streaming_fetch_delta(pages, 'https://new-delta');

    await service.sync_mailbox('t', 'user@test.com', {
      should_interrupt: () => interrupted,
    });

    expect(saved_delta_links()).toEqual({ 'folder-1': 'https://prev-delta' });
  });

  it('persists the new delta link when the folder completes without interrupt', async () => {
    const pages = [[make_message('m1')], [make_message('m2')]];
    connector.fetch_delta = make_streaming_fetch_delta(pages, 'https://new-delta');

    await service.sync_mailbox('t', 'user@test.com');

    expect(saved_delta_links()).toEqual({ 'folder-1': 'https://new-delta' });
  });
  it('honors cancellation requested by the finalizing progress event', async () => {
    let interrupted = false;
    connector.fetch_delta = make_streaming_fetch_delta([[make_message('m1')]], 'https://new-delta');

    const result = await service.sync_mailbox('t', 'user@test.com', {
      on_progress: (event) => {
        if (event.phase === 'finalizing') interrupted = true;
      },
      should_interrupt: () => interrupted,
    });

    expect(result.interrupted).toBe(true);
    expect(saved_delta_links()).toEqual({ 'folder-1': 'https://new-delta' });
  });
});
