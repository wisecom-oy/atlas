import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  MailboxConfigSource,
  MailboxDeltaCursor,
  Manifest,
} from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';

const owner = 'john.doe@example.com';

function source(categories: string[] = ['Example Category']): MailboxConfigSource {
  return {
    message_rules: [
      { id: 'r1', displayName: 'File invoices', actions: { moveToFolder: 'folder-1' } },
      { id: 'r2', displayName: 'Lost target', actions: { copyToFolder: 'unknown-folder' } },
    ],
    master_categories: categories.map((name) => ({ displayName: name, color: 'preset0' })),
    mailbox_settings: { timeZone: 'UTC', userPurpose: 'user' },
  };
}

function config_connector(fetch: () => Promise<MailboxConfigSource>): MailboxConfigConnector {
  return {
    fetch_mailbox_config: vi.fn(fetch),
    create_master_category: vi.fn(),
    update_master_category_color: vi.fn(),
    update_mailbox_settings: vi.fn(),
    create_message_rule: vi.fn(),
    update_message_rule: vi.fn(),
  };
}

type Harness = ReturnType<typeof create_mailbox_sync_harness>;

function saved_manifest(harness: Harness): Manifest {
  return vi.mocked(harness.mock_manifests.save).mock.calls[0]![1];
}

function saved_cursor(harness: Harness): MailboxDeltaCursor {
  return vi.mocked(harness.mock_cursors.save).mock.calls[0]![1];
}

/** Replays a finished run as the previous state of the next run. */
function resume_from(harness: Harness, manifest: Manifest, cursor: MailboxDeltaCursor): void {
  vi.mocked(harness.mock_manifests.save).mockClear();
  vi.mocked(harness.mock_cursors.save).mockClear();
  vi.mocked(harness.mock_context.storage.put).mockClear();
  vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue(manifest);
  vi.mocked(harness.mock_cursors.load).mockResolvedValue(cursor);
  vi.mocked(harness.mock_context.storage.exists).mockImplementation(
    async (key) => key === manifest.mailbox_config?.storage_key,
  );
}

describe('mailbox configuration backup', () => {
  it('stores one encrypted document that maps rule folders to their backup-time paths', async () => {
    const harness = create_mailbox_sync_harness(config_connector(async () => source()));

    await harness.service.sync_mailbox('test-tenant', owner);

    const ref = saved_manifest(harness).mailbox_config!;
    expect(ref.storage_key).toBe(`mailbox-config/${owner}/${ref.checksum}`);
    expect(saved_cursor(harness).mailbox_config).toEqual(ref);
    const [key, body] = vi.mocked(harness.mock_context.storage.put).mock.calls.at(-1)!;
    expect(key).toBe(ref.storage_key);
    const document = JSON.parse(body.subarray(1).toString('utf8')) as MailboxConfigDocument;
    expect(document.rule_folder_paths).toEqual({ 'folder-1': 'Inbox' });
    expect(document.mailbox_settings.timeZone).toBe('UTC');
  });

  it('writes neither an object nor a snapshot when mail and configuration are unchanged', async () => {
    const harness = create_mailbox_sync_harness(config_connector(async () => source()));
    await harness.service.sync_mailbox('test-tenant', owner);
    resume_from(harness, saved_manifest(harness), saved_cursor(harness));

    await harness.service.sync_mailbox('test-tenant', owner);

    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(harness.mock_context.storage.put).not.toHaveBeenCalled();
  });

  it('writes a snapshot when only the configuration changed', async () => {
    let categories = ['Example Category'];
    const harness = create_mailbox_sync_harness(config_connector(async () => source(categories)));
    await harness.service.sync_mailbox('test-tenant', owner);
    const first = saved_manifest(harness);
    resume_from(harness, first, saved_cursor(harness));
    categories = ['Example Category', 'Another Category'];

    await harness.service.sync_mailbox('test-tenant', owner);

    expect(harness.mock_manifests.save).toHaveBeenCalledOnce();
    expect(saved_manifest(harness).mailbox_config!.checksum).not.toBe(
      first.mailbox_config!.checksum,
    );
  });

  it('warns once and keeps the mail snapshot when MailboxSettings.Read is missing', async () => {
    const harness = create_mailbox_sync_harness(
      config_connector(async () => {
        throw new AuthError('Access denied');
      }),
    );

    const result = await harness.service.sync_mailbox('test-tenant', owner);

    expect(harness.mock_manifests.save).toHaveBeenCalledOnce();
    expect(result.summary.folder_errors).toEqual([]);
    const permission_warnings = result.summary.warnings.filter((warning: string) =>
      warning.includes('MailboxSettings.Read'),
    );
    expect(permission_warnings).toHaveLength(1);
  });

  it('keeps the previous configuration and reports the run partial on a transient failure', async () => {
    let fail = false;
    const harness = create_mailbox_sync_harness(
      config_connector(async () => {
        if (fail) throw new Error('Graph unavailable');
        return source();
      }),
    );
    await harness.service.sync_mailbox('test-tenant', owner);
    const first = saved_manifest(harness);
    resume_from(harness, first, saved_cursor(harness));
    fail = true;

    const result = await harness.service.sync_mailbox('test-tenant', owner);

    expect(result.summary.folder_errors).toEqual(['Mailbox configuration: Graph unavailable']);
    expect(saved_cursor(harness).mailbox_config).toEqual(first.mailbox_config);
  });
});
