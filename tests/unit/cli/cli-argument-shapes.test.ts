import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';

import { register_verify_command } from '@/cli/commands/verify.command';
import { register_stats_command } from '@/cli/commands/stats.command';
import { register_list_command } from '@/cli/commands/list.command';
import { register_restore_command } from '@/cli/commands/restore.command';
import { register_delete_command } from '@/cli/commands/delete.command';
import { register_save_command } from '@/cli/commands/save.command';

import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { VERIFICATION_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { STATS_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { CATALOG_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { RESTORE_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { DELETION_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { SAVE_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';

import type { VerificationUseCase } from '@/ports/verification/use-case.port';
import type { StatsUseCase } from '@/ports/stats/use-case.port';
import type { CatalogUseCase } from '@/ports/catalog/use-case.port';
import type { RestoreUseCase } from '@/ports/restore/use-case.port';
import type { DeletionUseCase } from '@/ports/deletion/use-case.port';
import type { SaveUseCase } from '@/ports/save/use-case.port';
import type { Manifest } from '@/domain/manifest';

function make_minimal_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'mid',
    tenant_id: 'tid',
    mailbox_id: 'm@example.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2024-06-01T00:00:00Z'),
    total_objects: 1,
    total_size_bytes: 100,
    delta_links: {},
    entries: [
      {
        object_id: 'oid',
        storage_key: 'k',
        checksum: 'c',
        size_bytes: 10,
        subject: 'Hi',
      },
    ],
    ...overrides,
  };
}

describe('CLI argv → handler shape', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'cfg-tenant' });
  });

  it('verify passes tenant and snapshot to the use case', async () => {
    const verify = vi.fn().mockResolvedValue({
      snapshot_id: 's1',
      total_checked: 0,
      passed: 0,
      failed: [],
    });
    container.bind<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN).toConstantValue({
      verify_snapshot_integrity: verify,
    });

    const program = new Command();
    register_verify_command(program, () => container);
    await program.parseAsync(['verify', '-s', 'snap-a', '-t', 'cli-tenant'], { from: 'user' });

    expect(verify).toHaveBeenCalledWith('cli-tenant', 'snap-a');
  });

  it('stats --json calls mailbox stats with correct tenant/mailbox', async () => {
    const get_mailbox_stats = vi.fn().mockResolvedValue({
      mailbox_id: 'a@b.com',
      snapshot_count: 0,
      total_messages: 0,
      total_size_bytes: 0,
      attachment_count: 0,
      attachment_size_bytes: 0,
      folders: [],
      monthly_breakdown: [],
      aggregation_us: 0,
    });
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    container.bind<StatsUseCase>(STATS_USE_CASE_TOKEN).toConstantValue({
      get_bucket_stats: vi.fn(),
      get_mailbox_stats,
    });

    const program = new Command();
    register_stats_command(program, () => container);
    await program.parseAsync(['stats', '-t', 't-stats', '-m', 'box@t.com', '--json'], {
      from: 'user',
    });

    expect(get_mailbox_stats).toHaveBeenCalledWith('t-stats', 'box@t.com');
    const json_line = log_spy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].startsWith('{'),
    );
    expect(json_line).toBeDefined();
    expect(JSON.parse(json_line![0] as string).mailbox_id).toBe('a@b.com');
    log_spy.mockRestore();
  });

  it('list routes -t / -m / -s and passes --all / -S into catalog calls', async () => {
    const list_mailboxes = vi.fn().mockResolvedValue([]);
    const list_snapshots = vi.fn().mockResolvedValue([]);
    const get_snapshot_detail = vi.fn().mockResolvedValue(make_minimal_manifest());
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    container.bind<CatalogUseCase>(CATALOG_USE_CASE_TOKEN).toConstantValue({
      list_mailboxes,
      list_snapshots,
      get_snapshot_detail,
      read_message: vi.fn(),
    } as unknown as CatalogUseCase);

    const program = new Command();
    register_list_command(program, () => container);

    await program.parseAsync(['list', '-t', 't-list'], { from: 'user' });
    expect(list_mailboxes).toHaveBeenCalledWith('t-list');

    list_mailboxes.mockClear();
    await program.parseAsync(['list', '-t', 't2', '-m', 'm@x.com'], { from: 'user' });
    expect(list_snapshots).toHaveBeenCalledWith('t2', 'm@x.com');

    list_snapshots.mockClear();
    await program.parseAsync(['list', '-t', 't3', '-m', 'm@x.com', '-s', 'snap-z', '--all', '-S'], {
      from: 'user',
    });
    expect(get_snapshot_detail).toHaveBeenCalledWith('t3', 'snap-z');
    expect(log_spy.mock.calls.some((c) => String(c[0]).includes('Hi'))).toBe(true);
    log_spy.mockRestore();
  });

  it('restore maps snapshot mode flags into restore_snapshot options', async () => {
    const restore_snapshot = vi.fn().mockResolvedValue({
      snapshot_id: 's',
      restored_count: 0,
      attachment_count: 0,
      error_count: 0,
      attachment_error_count: 0,
      verification_failures: 0,
      errors: [],
      restore_folder_name: '',
    });
    container.bind<RestoreUseCase>(RESTORE_USE_CASE_TOKEN).toConstantValue({
      restore_snapshot,
      restore_mailbox: vi.fn(),
    });

    const program = new Command();
    register_restore_command(program, () => container);
    await program.parseAsync(
      [
        'restore',
        '-s',
        'snap-1',
        '-t',
        't-restore',
        '-f',
        'Inbox',
        '--message',
        '3',
        '-T',
        'target@other.com',
      ],
      { from: 'user' },
    );

    expect(restore_snapshot).toHaveBeenCalledWith('t-restore', 'snap-1', {
      folder_name: 'Inbox',
      message_ref: '3',
      target_mailbox: 'target@other.com',
    });
  });

  it('restore maps mailbox mode date range and --target into restore_mailbox options', async () => {
    const restore_mailbox = vi.fn().mockResolvedValue({
      snapshot_id: '',
      restored_count: 0,
      attachment_count: 0,
      error_count: 0,
      attachment_error_count: 0,
      verification_failures: 0,
      errors: [],
      restore_folder_name: '',
    });
    container.bind<RestoreUseCase>(RESTORE_USE_CASE_TOKEN).toConstantValue({
      restore_snapshot: vi.fn(),
      restore_mailbox,
    });

    const program = new Command();
    register_restore_command(program, () => container);
    await program.parseAsync(
      [
        'restore',
        '-m',
        'src@t.com',
        '-t',
        'tenant-x',
        '--start-date',
        '2024-01-15',
        '--end-date',
        '2024-02-01',
        '-T',
        'dst@t.com',
        '-f',
        'Archive',
      ],
      { from: 'user' },
    );

    expect(restore_mailbox).toHaveBeenCalledWith(
      'tenant-x',
      'src@t.com',
      expect.objectContaining({
        folder_name: 'Archive',
        target_mailbox: 'dst@t.com',
        start_date: new Date('2024-01-15T00:00:00.000Z'),
        end_date: new Date('2024-02-01T00:00:00.000Z'),
      }),
    );
  });

  it('delete --purge -y dispatches purge with resolved tenant', async () => {
    const purge_tenant = vi.fn().mockResolvedValue({
      deleted_objects: 1,
      deleted_manifests: 0,
      retained_objects: 0,
      retained_manifests: 0,
      failed_objects: 0,
      failed_manifests: 0,
    });
    container.bind<DeletionUseCase>(DELETION_USE_CASE_TOKEN).toConstantValue({
      delete_mailbox_data: vi.fn(),
      delete_snapshot: vi.fn(),
      purge_tenant,
    });

    const program = new Command();
    register_delete_command(program, () => container);
    await program.parseAsync(['delete', '--purge', '-y', '-t', 'del-tenant'], { from: 'user' });

    expect(purge_tenant).toHaveBeenCalledWith('del-tenant');
  });

  it('save maps --skip-verify and -o into save_snapshot options', async () => {
    const save_snapshot = vi.fn().mockResolvedValue({
      snapshot_id: 's',
      saved_count: 0,
      attachment_count: 0,
      error_count: 0,
      errors: [],
      output_path: '/tmp/out.zip',
      total_bytes: 0,
      integrity_failures: [],
    });
    container.bind<SaveUseCase>(SAVE_USE_CASE_TOKEN).toConstantValue({
      save_snapshot,
      save_mailbox: vi.fn(),
    });

    const program = new Command();
    register_save_command(program, () => container);
    await program.parseAsync(
      ['save', '-s', 'snap-x', '-t', 't-save', '-o', '/tmp/atlas-test-out.zip', '--skip-verify'],
      { from: 'user' },
    );

    expect(save_snapshot).toHaveBeenCalledWith('t-save', 'snap-x', {
      output_path: '/tmp/atlas-test-out.zip',
      skip_integrity_check: true,
    });
  });
});
