import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    mock_run_backup_with_cli_adapter.mockResolvedValue({
      snapshot: { id: 'snap-1' },
      manifest: { total_objects: 1, total_size_bytes: 10 },
    });
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
