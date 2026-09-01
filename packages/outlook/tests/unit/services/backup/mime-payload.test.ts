import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type {
  BackupProgressReporter,
  MailboxConnector,
  MailMessage,
  ManifestEntry,
  ObjectStorage,
  TenantContext,
} from '@wisecom/atlas-types';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';
import { store_single_message } from '@/services/backup/message-payload-store';

const MIME = Buffer.from('Received: from mx.example.com\r\nSubject: Hi\r\n\r\nbody\r\n');

function make_message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    message_id: 'msg-1',
    folder_id: 'folder-1',
    subject: 'Hi',
    received_at: new Date('2026-03-10T14:30:22.000Z'),
    size_bytes: 42,
    raw_body: Buffer.from('{"id":"msg-1"}'),
    has_attachments: false,
    ...overrides,
  };
}

interface StoreHarness {
  readonly ctx: TenantContext;
  readonly put: ReturnType<typeof vi.fn>;
}

function make_ctx(already_stored = false): StoreHarness {
  const put = vi.fn();
  const storage = {
    put,
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(already_stored),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    begin_multipart_upload: vi.fn(),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  } as unknown as ObjectStorage;

  const ctx = {
    tenant_id: 't',
    storage,
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  return { ctx, put };
}

function make_progress(): BackupProgressReporter {
  return {
    set_status: vi.fn(),
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_paging: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    mark_error: vi.fn(),
    update_total: vi.fn(),
  } as unknown as BackupProgressReporter;
}

describe('store_single_message payload selection', () => {
  it('stores the MIME bytes, not the JSON payload, when MIME was captured', async () => {
    const { ctx, put } = make_ctx();

    const { manifest_entry } = await store_single_message(
      ctx,
      make_message(),
      'owner-1',
      undefined,
      MIME,
    );

    const [, ciphertext] = put.mock.calls[0]!;
    expect(Buffer.compare((ciphertext as Buffer).subarray(1), MIME)).toBe(0);
    expect(manifest_entry.payload_format).toBe('mime');
    expect(manifest_entry.size_bytes).toBe(MIME.length);
    expect(manifest_entry.received_at).toBe('2026-03-10T14:30:22.000Z');
  });

  it('addresses MIME entries by the hash of the MIME itself', async () => {
    const { ctx } = make_ctx();
    const mime_result = await store_single_message(ctx, make_message(), 'o', undefined, MIME);
    const json_result = await store_single_message(ctx, make_message(), 'o');

    expect(mime_result.manifest_entry.checksum).not.toBe(json_result.manifest_entry.checksum);
    expect(mime_result.manifest_entry.storage_key).toContain(mime_result.manifest_entry.checksum);
  });

  it('falls back to the JSON payload and marks no format when MIME is absent', async () => {
    const { ctx, put } = make_ctx();
    const message = make_message();

    const { manifest_entry } = await store_single_message(ctx, message, 'owner-1');

    const [, ciphertext] = put.mock.calls[0]!;
    expect(Buffer.compare((ciphertext as Buffer).subarray(1), message.raw_body)).toBe(0);
    expect(manifest_entry.payload_format).toBeUndefined();
    expect(manifest_entry.received_at).toBeUndefined();
  });
});

interface SyncOutcome {
  readonly fetch_attachments: ReturnType<typeof vi.fn>;
  readonly entries: ManifestEntry[];
}

async function run_folder_sync(fetch_mime: MailboxConnector['fetch_mime']): Promise<SyncOutcome> {
  const fetch_attachments = vi.fn().mockResolvedValue([]);
  const message = make_message({ has_attachments: true });
  const connector = {
    list_mailboxes: vi.fn(),
    mailbox_exists: vi.fn().mockResolvedValue(true),
    list_mail_folders: vi.fn().mockResolvedValue([]),
    fetch_message: vi.fn(),
    fetch_attachments,
    fetch_mime,
    fetch_delta: vi.fn(
      async (
        _t: string,
        _o: string,
        _f: string,
        _prev: string | undefined,
        on_page?: (p: number, t: number, m: MailMessage[]) => Promise<boolean> | boolean | void,
      ) => {
        if (on_page) await on_page(1, 1, [message]);
        return { messages: [], removed_ids: [], delta_link: 'd', delta_reset: false };
      },
    ),
  } as unknown as MailboxConnector;

  const { ctx } = make_ctx();
  const never = (): boolean => false;
  const result = await sync_single_folder({
    ctx,
    connector,
    tenant_id: 't',
    owner_id: 'owner-1',
    folder_id: 'folder-1',
    folder_index: 0,
    folder_total: 1,
    global_total: 1,
    global_processed_before: 0,
    sync_start: Date.now(),
    progress: make_progress(),
    is_interrupted: never,
    is_hard_stopped: never,
    operation_control: {},
  });

  return { fetch_attachments, entries: result.entries };
}

describe('MIME capture in the folder sync path', () => {
  it('skips the separate attachment fetch when MIME embedded them', async () => {
    const { fetch_attachments, entries } = await run_folder_sync(vi.fn().mockResolvedValue(MIME));

    expect(fetch_attachments).not.toHaveBeenCalled();
    expect(entries[0]?.payload_format).toBe('mime');
  });

  it('still fetches attachments separately for a JSON fallback entry', async () => {
    const { fetch_attachments, entries } = await run_folder_sync(
      vi.fn().mockResolvedValue(undefined),
    );

    expect(fetch_attachments).toHaveBeenCalled();
    expect(entries[0]?.payload_format).toBeUndefined();
  });

  it('degrades one message to JSON when MIME capture throws', async () => {
    const { fetch_attachments, entries } = await run_folder_sync(
      vi.fn().mockRejectedValue(new Error('boom')),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload_format).toBeUndefined();
    expect(fetch_attachments).toHaveBeenCalled();
  });
});
