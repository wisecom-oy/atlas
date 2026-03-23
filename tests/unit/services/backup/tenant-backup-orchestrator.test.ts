import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { DefaultTenantBackupOrchestrator } from '@/services/backup/tenant-backup-orchestrator';
import { MAILBOX_DISCOVERY_TOKEN } from '@/ports/tokens/outgoing.tokens';
import { BACKUP_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import type { MailboxDiscoveryService, TenantMailbox } from '@/ports/mailbox/discovery.port';
import type { BackupUseCase, SyncResult, BackupSyncSummary } from '@/ports/backup/use-case.port';
import type { Manifest } from '@/domain/manifest';
import type { Snapshot } from '@/domain/snapshot';
import { SnapshotStatus } from '@/domain/snapshot';

function make_mailbox(mail: string, licensed = true): TenantMailbox {
  return { user_id: `uid-${mail}`, mail, display_name: mail, has_exchange_license: licensed };
}

function make_sync_result(mailbox_id: string): SyncResult {
  const summary: BackupSyncSummary = {
    stored: 5,
    deduplicated: 2,
    attachments_stored: 1,
    processed: 7,
    folder_errors: [],
    warnings: [],
    interrupted: false,
    completed_folder_count: 2,
    total_folder_count: 2,
    elapsed_ms: 1000,
  };
  return {
    snapshot: {
      id: `snap-${mailbox_id}`,
      tenant_id: 't1',
      mailbox_id,
      status: SnapshotStatus.COMPLETED,
      created_at: new Date(),
      completed_at: new Date(),
      entry_count: 7,
    } as Snapshot,
    manifest: { total_objects: 7, total_size_bytes: 1000 } as Manifest,
    mode: 'incremental',
    summary,
  };
}

describe('DefaultTenantBackupOrchestrator', () => {
  let container: Container;
  let mock_discovery: MailboxDiscoveryService;
  let mock_backup: BackupUseCase;

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

  it('always discovers licensed-only mailboxes', async () => {
    const orch = container.get(DefaultTenantBackupOrchestrator);
    await orch.backup_tenant('t1');

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('t1', {
      licensed_only: true,
    });
  });

  it('captures errors per mailbox without aborting', async () => {
    (mock_backup.sync_mailbox as ReturnType<typeof vi.fn>).mockImplementation(
      (_tid: string, mid: string) => {
        if (mid === 'b@t.com') return Promise.reject(new Error('boom'));
        return Promise.resolve(make_sync_result(mid));
      },
    );

    const orch = container.get(DefaultTenantBackupOrchestrator);
    const result = await orch.backup_tenant('t1', { concurrency: 1 });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const failed = result.outcomes.find((o) => o.mailbox_id === 'b@t.com');
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
});
