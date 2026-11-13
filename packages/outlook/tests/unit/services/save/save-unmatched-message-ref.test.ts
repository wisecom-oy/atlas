import { outlook_stub_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SaveService } from '@/services/save/save.service';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  ManifestRepository,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry, TenantContext } from '@wisecom/atlas-types';

/**
 * Issue #735: a `--message` reference that names no message in the snapshot must fail with
 * NotFoundError before any archive is opened, and a stream destination is destroyed.
 */
vi.mock('@/services/save/save-entry-processor', () => ({
  save_entries_to_archive: vi.fn().mockResolvedValue({
    saved_count: 1,
    attachment_count: 0,
    error_count: 0,
    errors: [],
    output_path: 'test.zip',
    total_bytes: 512,
    integrity_failures: [],
    processed: 1,
    interrupted: false,
  }),
}));

function make_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: 'abc',
    size_bytes: 100,
    subject: `Subject ${id}`,
    folder_id,
  };
}

function make_manifest(
  entries: ManifestEntry[],
  opts?: { snapshot_id?: string; created_at?: Date },
): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: opts?.snapshot_id ?? 'snap-1',
    created_at: opts?.created_at ?? new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('SaveService with a message reference that names no message (#735)', () => {
  let container: Container;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let service: SaveService;

  beforeEach(() => {
    vi.mocked(save_entries_to_archive).mockClear();
    container = new Container();

    const mock_context = {
      storage: { get: vi.fn(), put: vi.fn(), exists: vi.fn(), delete: vi.fn() },
      decrypt: vi.fn((buf: Buffer) => buf),
      encrypt: vi.fn((buf: Buffer) => buf),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_readonly: vi.fn().mockResolvedValue(mock_context),
      create_storage_only: vi.fn().mockResolvedValue(mock_context),
    };

    mock_manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue(make_manifest([make_entry('msg-1', 'f1')])),
      list_all_manifests: vi.fn().mockResolvedValue([]),
      list_by_owner: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      list_snapshots: vi.fn().mockResolvedValue([]),
      delete_snapshot: vi.fn(),
      ...outlook_stub_chain_reads(),
    } as unknown as ManifestRepository;

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi
        .fn()
        .mockResolvedValue([{ folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' }]),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn(),
    } as unknown as MailboxConnector;

    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(SaveService).toSelf();

    service = container.get(SaveService);
  });

  it.each(['99', 'AAMkAG-no-such-id'])(
    'rejects %j with NotFoundError that names the reference',
    async (message_ref) => {
      const run = service.save_snapshot('test-tenant', 'snap-1', {
        message_ref,
        output_path: 'out.zip',
      });

      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow(`No message matches "${message_ref}" in snapshot snap-1`);
    },
  );

  it('opens no archive and does not reach the mailbox when it rejects', async () => {
    await expect(
      service.save_snapshot('test-tenant', 'snap-1', { message_ref: '99', output_path: 'out.zip' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(save_entries_to_archive).not.toHaveBeenCalled();
    expect(mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('destroys a stream destination it was handed when it rejects', async () => {
    const sink = new PassThrough();

    await expect(
      service.save_snapshot('test-tenant', 'snap-1', { message_ref: '99', output: sink }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(save_entries_to_archive).not.toHaveBeenCalled();
    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('exports a message carried over from an earlier snapshot of the chain (#432, #735)', async () => {
    const first = make_manifest([make_entry('msg-1', 'f1')], {
      created_at: new Date('2026-01-01'),
    });
    const delta = make_manifest([make_entry('msg-2', 'f1')], {
      snapshot_id: 'snap-2',
      created_at: new Date('2026-01-02'),
    });
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(delta);
    vi.mocked(mock_manifests.list_by_owner).mockResolvedValue([first, delta]);

    const result = await service.save_snapshot('test-tenant', 'snap-2', {
      message_ref: 'msg-1',
      output_path: 'out.zip',
    });

    expect(result.snapshot_id).toBe('snap-2');
    const groups = vi.mocked(save_entries_to_archive).mock.lastCall?.[4];
    const saved = [...(groups?.values() ?? [])].flat().map((e) => e.object_id);
    expect(saved).toEqual(['msg-1']);
  });
});
