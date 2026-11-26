/**
 * Issue #893: a message create that ended with a 5xx, a timeout or a dropped connection may have
 * landed in the target, while a refused one did not. The restore result lists the first kind in
 * `outcome_unknown`, beside its line in `errors`, and never lists a refusal.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateOutcomeUnknownError,
  UploadCommitUnknownError,
  type ManifestEntry,
  type MailboxConnector,
  type RestoreConnector,
  type TenantContext,
  type TransferProgressReporter,
} from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { execute_restore_loop } from '@/services/restore/restore-loop-executor';
import { restore_single_message } from '@/services/restore/restore-execution-orchestrator';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const MESSAGE = Buffer.from(JSON.stringify({ subject: 'Example subject', parentFolderId: 'f1' }));
const ATTACHMENT = Buffer.from('attachment-bytes');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function make_entry(object_id: string, folder_id: string, attachments = 0): ManifestEntry {
  return {
    object_id,
    storage_key: `data/user/${object_id}`,
    checksum: sha256(MESSAGE),
    size_bytes: MESSAGE.length,
    folder_id,
    ...(attachments > 0 && {
      attachments: Array.from({ length: attachments }, (_, i) => ({
        attachment_id: `${object_id}-att-${i}`,
        name: `file-${i}.pdf`,
        content_type: 'application/pdf',
        size_bytes: ATTACHMENT.length,
        is_inline: false,
        storage_key: `attachments/${object_id}-${i}`,
        checksum: sha256(ATTACHMENT),
      })),
    }),
  } as ManifestEntry;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      get: vi.fn(async (key: string) => (key.startsWith('attachments/') ? ATTACHMENT : MESSAGE)),
      put: vi.fn(),
    },
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_dashboard(): TransferProgressReporter {
  return {
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    mark_done: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    finish: vi.fn(),
  } as unknown as TransferProgressReporter;
}

/** A mailbox that creates folders and messages, failing message `fail_on` with `failure`. */
function make_connector(fail_on?: string, failure?: () => unknown): RestoreConnector {
  let created = 0;
  return {
    create_mail_folder: vi.fn(async (_t: string, _o: string, name: string) => ({
      folder_id: `created-${name}`,
      display_name: name,
    })),
    create_message: vi.fn(async () => {
      created++;
      if (`msg-${created}` === fail_on && failure) throw failure();
      return `new-msg-${created}`;
    }),
    add_attachment: vi.fn().mockResolvedValue(undefined),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
  } as unknown as RestoreConnector;
}

/** Two folders: msg-1 and msg-2 in Inbox, msg-3 in Archive. */
function two_folders(attachments = 0): Map<string, ManifestEntry[]> {
  return new Map([
    ['f1', [make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1', attachments)]],
    ['f2', [make_entry('msg-3', 'f2')]],
  ]);
}

function run(connector: RestoreConnector, groups = two_folders(), dashboard = make_dashboard()) {
  return execute_restore_loop(
    make_ctx(),
    connector,
    'tenant-1',
    'john.doe@example.com',
    'snap-1',
    { folder_id: 'root-1', display_name: 'Restore-2026' },
    groups,
    new Map([
      ['f1', 'Inbox'],
      ['f2', 'Archive'],
    ]),
    new Map<string, string>(),
    dashboard,
    {},
  );
}

function unknown_outcome(): CreateOutcomeUnknownError {
  return new CreateOutcomeUnknownError('HTTP 504 -- GatewayTimeout');
}

function refusal(status: number): Error {
  return Object.assign(new Error(`Graph refused the create (${status})`), { statusCode: status });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Outlook restore of a message whose create outcome is unknown (issue #893)', () => {
  it('lists the message in outcome_unknown and its error, and restores the rest', async () => {
    const result = await run(make_connector('msg-2', unknown_outcome));

    const line = `msg-2: ${unknown_outcome().message}`;
    expect(result.errors).toEqual([line]);
    expect(result.error_count).toBe(1);
    expect(result.restored_count).toBe(2);
    expect(result.outcome_unknown).toEqual([
      { object_id: 'msg-2', target_folder_id: 'created-Inbox', error: line },
    ]);
    expect(line).toMatch(/^msg-2: outcome unknown, the item may exist: .*HTTP 504/);
  });

  it.each([400, 403, 404, 409, 413])(
    'does not list a message Graph refused with %i',
    async (status) => {
      const result = await run(make_connector('msg-2', () => refusal(status)));

      expect(result.errors).toEqual([`msg-2: Graph refused the create (${status})`]);
      expect(result.outcome_unknown).toEqual([]);
    },
  );

  it('still lists the message when Ctrl+C was pressed while its create was in flight', async () => {
    const controller = new AbortController();
    const connector = make_connector('msg-2', () => {
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return unknown_outcome();
    });

    const result = await run_with_abort_signal(controller.signal, () => run(connector));

    expect(result.outcome_unknown.map((item) => item.object_id)).toEqual(['msg-2']);
    expect(result.errors).toEqual([`msg-2: ${unknown_outcome().message}`]);
  });

  it('lists a created message whose attachment create outcome is unknown, naming it', async () => {
    const connector = make_connector();
    const upload_unknown = new UploadCommitUnknownError(
      { range: 'bytes 0-15/16', item: 'attachment' },
      'HTTP 502',
    );
    vi.mocked(connector.add_attachment).mockRejectedValue(upload_unknown);

    const result = await run(connector, two_folders(1));

    const line = `msg-2: file-0.pdf: ${upload_unknown.message}`;
    expect(result.restored_count).toBe(3);
    expect(result.errors).toEqual([line]);
    expect(result.outcome_unknown).toEqual([
      {
        object_id: 'msg-2',
        target_folder_id: 'created-Inbox',
        attachment_name: 'file-0.pdf',
        error: line,
      },
    ]);
  });
});

describe('Outlook single-message restore whose create outcome is unknown (issue #893)', () => {
  it('resolves with the message listed instead of rejecting', async () => {
    const mailbox = {
      list_mail_folders: vi.fn().mockResolvedValue([]),
    } as unknown as MailboxConnector;

    const result = await restore_single_message(
      make_ctx(),
      mailbox,
      make_connector('msg-1', unknown_outcome),
      'tenant-1',
      'john.doe@example.com',
      'john.doe@example.com',
      'snap-1',
      make_entry('msg-1', 'f1'),
      {
        folder_id: 'root-1',
        display_name: 'Restore-2026',
        folder_path: 'Restore-2026',
        total_item_count: 0,
      },
    );

    expect(result.restored_count).toBe(0);
    expect(result.error_count).toBe(1);
    expect(result.outcome_unknown).toEqual([
      expect.objectContaining({ object_id: 'msg-1', error: result.errors[0] }),
    ]);
  });

  it('still rejects with a refusal', async () => {
    const mailbox = {
      list_mail_folders: vi.fn().mockResolvedValue([]),
    } as unknown as MailboxConnector;

    await expect(
      restore_single_message(
        make_ctx(),
        mailbox,
        make_connector('msg-1', () => refusal(400)),
        'tenant-1',
        'john.doe@example.com',
        'john.doe@example.com',
        'snap-1',
        make_entry('msg-1', 'f1'),
        {
          folder_id: 'root-1',
          display_name: 'Restore-2026',
          folder_path: 'Restore-2026',
          total_item_count: 0,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
