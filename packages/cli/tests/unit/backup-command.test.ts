import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook.command';
import { BACKUP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

const mock_run_backup_with_cli_adapter = vi.fn();

vi.mock('@/adapters/backup-operation.adapter', () => ({
  run_backup_with_cli_adapter: (...args: unknown[]): unknown =>
    mock_run_backup_with_cli_adapter(...args),
}));

function make_sync_result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot: { id: 'snap-1' },
    manifest: { total_objects: 1, total_size_bytes: 10 },
    summary: {
      folder_errors: [],
      warnings: [],
      excluded_folders: [],
      interrupted: false,
      ...overrides,
    },
  };
}

describe('outlook backup command immutability options', () => {
  let container: Container;
  let program: Command;

  beforeEach(() => {
    container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({
      sync_mailbox: vi.fn(),
    });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({
      tenant_id: 'tenant-from-config',
    });

    program = new Command();
    register_outlook_command(program, () => container);
    mock_run_backup_with_cli_adapter.mockReset();
    mock_run_backup_with_cli_adapter.mockResolvedValue(make_sync_result());
  });

  it('resolves retention-days into retain_until and maps governance mode', async () => {
    await program.parseAsync(
      [
        'outlook',
        'backup',
        '--mailbox',
        'user@test.com',
        '--retention-days',
        '30',
        '--lock-mode',
        'governance',
      ],
      { from: 'user' },
    );

    const sync_options = mock_run_backup_with_cli_adapter.mock.calls[0][3];
    expect(sync_options.object_lock_policy.mode).toBe('GOVERNANCE');
    expect(sync_options.object_lock_policy.retain_until).toBeDefined();
    expect(sync_options.object_lock_request.retention_days).toBe(30);
  });

  it('accepts compliance mode', async () => {
    await program.parseAsync(
      [
        'outlook',
        'backup',
        '--mailbox',
        'user@test.com',
        '--retention-days',
        '365',
        '--lock-mode',
        'compliance',
      ],
      { from: 'user' },
    );

    const sync_options = mock_run_backup_with_cli_adapter.mock.calls[0][3];
    expect(sync_options.object_lock_policy.mode).toBe('COMPLIANCE');
    expect(sync_options.object_lock_request.mode).toBe('COMPLIANCE');
  });
});

describe('outlook backup requires a mailbox (issue #166)', () => {
  let container: Container;
  let program: Command;

  beforeEach(() => {
    container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox: vi.fn() });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });

    program = new Command();
    program.exitOverride();
    register_outlook_command(program, () => container);
    mock_run_backup_with_cli_adapter.mockReset();
  });

  it('rejects the invocation without running a backup when -m is omitted', async () => {
    await expect(program.parseAsync(['outlook', 'backup'], { from: 'user' })).rejects.toThrow(
      /mailbox/,
    );
    expect(mock_run_backup_with_cli_adapter).not.toHaveBeenCalled();
  });
});

describe('outlook backup single-mailbox exit code (issue #32)', () => {
  let container: Container;
  let program: Command;
  let exit_code_before: string | number | undefined;

  beforeEach(() => {
    container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox: vi.fn() });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });

    program = new Command();
    register_outlook_command(program, () => container);
    mock_run_backup_with_cli_adapter.mockReset();
    exit_code_before = process.exitCode ?? undefined;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exit_code_before;
  });

  it('exits 2 when any folder failed even though a snapshot was saved', async () => {
    mock_run_backup_with_cli_adapter.mockResolvedValue(
      make_sync_result({ folder_errors: ['Inbox: Graph timeout'] }),
    );

    await program.parseAsync(['outlook', 'backup', '-m', 'user@t.com'], { from: 'user' });

    expect(process.exitCode).toBe(2);
  });

  it('exits 2 when the run was interrupted', async () => {
    mock_run_backup_with_cli_adapter.mockResolvedValue(make_sync_result({ interrupted: true }));

    await program.parseAsync(['outlook', 'backup', '-m', 'user@t.com'], { from: 'user' });

    expect(process.exitCode).toBe(2);
  });

  it('keeps a clean exit code on a fully successful run', async () => {
    mock_run_backup_with_cli_adapter.mockResolvedValue(make_sync_result());

    await program.parseAsync(['outlook', 'backup', '-m', 'user@t.com'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
  });
});
