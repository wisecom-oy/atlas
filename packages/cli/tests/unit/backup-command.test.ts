import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook.command';
import { BACKUP_USE_CASE_TOKEN, USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

const mock_run_backup_with_cli_adapter = vi.fn();

vi.mock('@/adapters/backup-operation.adapter', () => ({
  run_backup_with_cli_adapter: (...args: unknown[]): unknown =>
    mock_run_backup_with_cli_adapter(...args),
}));

const OWNER_OBJECT_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const identity_resolver = {
  resolve_user: vi.fn().mockResolvedValue({
    object_id: OWNER_OBJECT_ID,
    email: 'user@example.com',
    display_name: 'Example User',
  }),
};

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
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue(identity_resolver);

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

  it('backs up by resolved object ID and keeps the address as display metadata', async () => {
    await program.parseAsync(['outlook', 'backup', '-m', 'user@example.com'], { from: 'user' });

    const [, , mailbox_id, sync_options] = mock_run_backup_with_cli_adapter.mock.calls[0];
    expect(mailbox_id).toBe(OWNER_OBJECT_ID);
    expect(sync_options.owner_email).toBe('user@example.com');
    expect(sync_options.owner_display_name).toBe('Example User');
  });
});

describe('outlook backup requires a mailbox (issue #166)', () => {
  let container: Container;
  let program: Command;

  beforeEach(() => {
    container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox: vi.fn() });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue(identity_resolver);

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
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue(identity_resolver);

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
