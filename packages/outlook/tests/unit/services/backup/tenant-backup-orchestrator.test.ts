import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { DefaultTenantBackupOrchestrator } from '@/services/backup/tenant-backup-orchestrator';
import {
  MAILBOX_DISCOVERY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type { ManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { BACKUP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type { MailboxDiscoveryService, MailboxPurpose, TenantMailbox } from '@wisecom/atlas-types';
import type { BackupUseCase, SyncResult, BackupSyncSummary } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';
import type { Snapshot } from '@wisecom/atlas-types';
import { SnapshotStatus } from '@wisecom/atlas-types';

function make_mailbox(
  mail: string,
  licensed = true,
  purpose?: MailboxPurpose,
  purpose_lookup_error?: string,
): TenantMailbox {
  return {
    user_id: `uid-${mail}`,
    mail,
    display_name: mail,
    has_exchange_license: licensed,
    ...(purpose ? { mailbox_purpose: purpose } : {}),
    ...(purpose_lookup_error ? { purpose_lookup_error } : {}),
  };
}

function make_sync_result(mailbox_id: string): SyncResult {
  const summary: BackupSyncSummary = {
    stored: 5,
    deduplicated: 2,
    attachments_stored: 1,
    processed: 7,
    folder_errors: [],
    warnings: [],
    excluded_folders: [],
    interrupted: false,
    completed_folder_count: 2,
    total_folder_count: 2,
    elapsed_ms: 1000,
  };
  const snapshot: Snapshot = {
    id: `snap-${mailbox_id}`,
    tenant_id: 't1',
    owner_id: mailbox_id,
    status: SnapshotStatus.COMPLETED,
    started_at: new Date(),
    completed_at: new Date(),
    object_count: 7,
  };
  return {
    snapshot,
    manifest: { total_objects: 7, total_size_bytes: 1000 } as Manifest,
    mode: 'incremental',
    summary,
    interrupted: false,
  };
}

describe('DefaultTenantBackupOrchestrator', () => {
  let container: Container;
  let mock_discovery: MailboxDiscoveryService;
  let mock_backup: BackupUseCase;
  let owners_with_history: string[];

  beforeEach(() => {
    container = new Container();

    mock_discovery = {
      list_tenant_mailboxes: vi
        .fn()
        .mockResolvedValue([
          make_mailbox('a@t.com'),
          make_mailbox('b@t.com'),
          make_mailbox('c@t.com'),
        ]),
    };

    mock_backup = {
      sync_mailbox: vi
        .fn()
        .mockImplementation((_tid: string, mid: string) => Promise.resolve(make_sync_result(mid))),
    };

    container.bind(MAILBOX_DISCOVERY_TOKEN).toConstantValue(mock_discovery);
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue(mock_backup);
    owners_with_history = [];
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue({
      list_owner_ids: vi.fn(async () => owners_with_history),
    } as unknown as ManifestRepository);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
      create_storage_only: vi.fn(async () => ({})),
    } as unknown as TenantContextFactory);
    container.bind(DefaultTenantBackupOrchestrator).toSelf();
  });

  it('backs up all discovered mailboxes', async () => {
    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1', { concurrency: 2 });

    expect(result.total_mailboxes).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.outcomes).toHaveLength(3);
    expect(mock_backup.sync_mailbox).toHaveBeenCalledTimes(3);
  });

  it('includes shared mailboxes and skips plain unlicensed ones', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      make_mailbox('licensed@t.com', true),
      make_mailbox('shared@t.com', false, 'shared'),
      make_mailbox('unlicensed@t.com', false),
    ]);

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1');

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('t1');
    expect(mock_backup.sync_mailbox).toHaveBeenCalledTimes(2);
    const backed_up = vi.mocked(mock_backup.sync_mailbox).mock.calls.map((c) => c[1]);
    expect(backed_up).toContain('uid-licensed@t.com');
    expect(backed_up).toContain('uid-shared@t.com');
    expect(backed_up).not.toContain('uid-unlicensed@t.com');
    // Every discovered mailbox counts, including the quietly skipped one (#514).
    expect(result.total_mailboxes).toBe(3);
  });

  it('fails an excluded mailbox that has existing backups, naming it and the reason (#480)', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      make_mailbox('licensed@t.com', true),
      make_mailbox('converted@t.com', false),
      make_mailbox('lookup@t.com', false, undefined, '403 Forbidden'),
      make_mailbox('never@t.com', false),
    ]);
    owners_with_history = ['uid-licensed@t.com', 'uid-converted@t.com', 'uid-lookup@t.com'];

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1');

    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(1);
    const errors = new Map(result.outcomes.map((o) => [o.owner_id, o.error]));
    expect(errors.get('uid-converted@t.com')).toContain('no Exchange Online license');
    expect(errors.get('uid-lookup@t.com')).toContain(
      'mailboxSettings lookup failed (403 Forbidden)',
    );
    // Never backed up and unlicensed: still a quiet skip.
    expect(errors.has('uid-never@t.com')).toBe(false);
  });

  it('fails an excluded mailbox whose only history is a v5 address prefix (#514)', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      make_mailbox('licensed@t.com', true),
      make_mailbox('John.Doe@t.com', false),
      make_mailbox('never@t.com', false),
    ]);
    // v5 keyed Outlook prefixes by the lowercased primary SMTP address.
    owners_with_history = ['uid-licensed@t.com', 'john.doe@t.com'];

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1');

    const errors = new Map(result.outcomes.map((o) => [o.owner_id, o.error]));
    expect(errors.get('uid-John.Doe@t.com')).toContain('no Exchange Online license');
    expect(errors.has('uid-never@t.com')).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.total_mailboxes).toBe(3);
  });

  it('captures errors per mailbox without aborting', async () => {
    (mock_backup.sync_mailbox as ReturnType<typeof vi.fn>).mockImplementation(
      (_tid: string, mid: string) => {
        if (mid === 'uid-b@t.com') return Promise.reject(new Error('boom'));
        return Promise.resolve(make_sync_result(mid));
      },
    );

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1', { concurrency: 1 });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const failed = result.outcomes.find((o) => o.owner_id === 'uid-b@t.com');
    expect(failed?.error).toBe('boom');
  });

  it('stops processing when interrupted', async () => {
    let call_count = 0;
    (mock_backup.sync_mailbox as ReturnType<typeof vi.fn>).mockImplementation(
      (_tid: string, mid: string) => {
        call_count++;
        return Promise.resolve(make_sync_result(mid));
      },
    );

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1', {
      concurrency: 1,
      should_interrupt: () => call_count >= 1,
    });

    expect(result.interrupted).toBe(true);
    expect(call_count).toBeLessThanOrEqual(2);
  });

  it('returns empty result when no mailboxes', async () => {
    (mock_discovery.list_tenant_mailboxes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1');

    expect(result.total_mailboxes).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.outcomes).toHaveLength(0);
  });

  it('forwards object lock options to every mailbox sync (issue #29)', async () => {
    const orch = container.get(DefaultTenantBackupOrchestrator);
    await orch.backup_tenant('t1', {
      object_lock_request: { mode: 'COMPLIANCE', retention_days: 30 },
      object_lock_policy: {
        mode: 'COMPLIANCE',
        retain_until: '2030-01-01T00:00:00.000Z',
      },
    });

    const calls = vi.mocked(mock_backup.sync_mailbox).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , sync_options] of calls) {
      expect(sync_options?.object_lock_request).toEqual({
        mode: 'COMPLIANCE',
        retention_days: 30,
      });
      expect(sync_options?.object_lock_policy?.mode).toBe('COMPLIANCE');
    }
  });

  it('keys every mailbox by object ID and forwards the address as display metadata', async () => {
    const orch = container.get(DefaultTenantBackupOrchestrator);
    await orch.backup_tenant('t1', { concurrency: 1 });

    expect(mock_backup.sync_mailbox).toHaveBeenCalledWith(
      't1',
      'uid-a@t.com',
      expect.objectContaining({ owner_email: 'a@t.com', owner_display_name: 'a@t.com' }),
    );
  });
});
