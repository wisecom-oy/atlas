/**
 * Issue #871: an `AuthError` or `MailboxNotLicensedError` during an Outlook restore failed every
 * remaining message one by one and the run exited 2. It now ends the restore with the typed error,
 * after the messages restored before it, and sends nothing more.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  MailboxNotLicensedError,
  MissingGraphPermissionsError,
  type ManifestEntry,
  type RestoreConnector,
  type TenantContext,
  type TransferProgressReporter,
} from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { execute_restore_loop } from '@/services/restore/restore-loop-executor';

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

function missing_grant(): MissingGraphPermissionsError {
  return new MissingGraphPermissionsError('Microsoft Graph returned 403 Forbidden', {
    permissions: ['Mail.ReadWrite'],
    status_code: 403,
    graph_code: 'ErrorAccessDenied',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Outlook restore refused for the whole mailbox (issue #871)', () => {
  it.each([
    ['a missing grant', missing_grant],
    ['an unlicensed mailbox', () => new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')],
  ])('ends on %s and creates no further folder or message', async (_label, failure) => {
    const connector = make_connector('msg-2', failure);

    await expect(run(connector)).rejects.toMatchObject({ code: failure().code });
    expect(connector.create_message).toHaveBeenCalledTimes(2);
    expect(connector.create_mail_folder).toHaveBeenCalledTimes(1);
  });

  it('reports the messages restored before the refusal', async () => {
    const dashboard = make_dashboard();

    await run(make_connector('msg-2', missing_grant), two_folders(), dashboard).catch(
      () => undefined,
    );

    expect(dashboard.finish).toHaveBeenCalledWith(1);
    expect(dashboard.mark_all_pending_interrupted).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^1 restored, 0 attachments/));
  });

  it('ends on a refused folder create before any message of it is sent', async () => {
    const connector = make_connector();
    vi.mocked(connector.create_mail_folder).mockRejectedValue(
      new AuthError('Entra ID refused the client credentials'),
    );

    await expect(run(connector)).rejects.toBeInstanceOf(AuthError);
    expect(connector.create_message).not.toHaveBeenCalled();
    expect(connector.create_mail_folder).toHaveBeenCalledTimes(1);
  });

  it('ends on a refused attachment and sends neither its other attachments nor the next message', async () => {
    const connector = make_connector();
    vi.mocked(connector.add_attachment).mockRejectedValue(missing_grant());

    await expect(run(connector, two_folders(2))).rejects.toBeInstanceOf(
      MissingGraphPermissionsError,
    );
    expect(connector.add_attachment).toHaveBeenCalledTimes(1);
    expect(connector.create_message).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^2 restored/));
  });

  it('fails only the message on a failure of its own', async () => {
    const connector = make_connector('msg-2', () =>
      Object.assign(new Error('Graph 400'), { statusCode: 400 }),
    );

    const result = await run(connector);

    expect(connector.create_message).toHaveBeenCalledTimes(3);
    expect(result.restored_count).toBe(2);
    expect(result.errors).toEqual(['msg-2: Graph 400']);
  });

  it('reports a cancellation as an interrupt, not as the refusal', async () => {
    const controller = new AbortController();
    const connector = make_connector('msg-2', () => {
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return missing_grant();
    });

    const result = await run_with_abort_signal(controller.signal, () =>
      execute_restore_loop(
        make_ctx(),
        connector,
        'tenant-1',
        'john.doe@example.com',
        'snap-1',
        { folder_id: 'root-1', display_name: 'Restore-2026' },
        two_folders(),
        new Map([['f1', 'Inbox']]),
        new Map<string, string>(),
        make_dashboard(),
        { abort_signal: controller.signal },
      ),
    );

    expect(result.interrupted).toBe(true);
    expect(result.restored_count).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
