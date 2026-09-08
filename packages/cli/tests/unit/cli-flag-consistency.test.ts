import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { BACKUP_USE_CASE_TOKEN, STATS_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_onedrive_command } from '@/commands/onedrive.command';
import { register_outlook_command } from '@/commands/outlook.command';
import { register_stats_command } from '@/commands/stats.command';

const mock_run_backup = vi.fn();

vi.mock('@/adapters/backup-operation.adapter', () => ({
  run_backup_with_cli_adapter: (...args: unknown[]): unknown => mock_run_backup(...args),
}));

function make_sync_result(): Record<string, unknown> {
  return {
    snapshot: { id: 'snap-1' },
    manifest: { total_objects: 1, total_size_bytes: 10 },
    summary: { folder_errors: [], warnings: [], excluded_folders: [], interrupted: false },
  };
}

function make_container(): Container {
  const container = new Container();
  container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox: vi.fn() });
  container.bind(STATS_USE_CASE_TOKEN).toConstantValue({ get_bucket_stats: vi.fn() });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });
  return container;
}

function make_program(): Command {
  const container = make_container();
  const program = new Command();
  program.exitOverride();
  register_outlook_command(program, () => container);
  register_onedrive_command(program, () => container);
  register_stats_command(program, () => container);
  return program;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mock_run_backup.mockReset();
  mock_run_backup.mockResolvedValue(make_sync_result());
});

/**
 * v5.0.0 reassigns three short flags. A script that kept the old spelling has to fail naming the
 * replacement: resolving `stats -s <site>` as a snapshot id would report on the wrong scope, and
 * `outlook save -o <path>` as an owner would put the archive somewhere else (issues #162, #322).
 */
describe('retired short flags', () => {
  let program: Command;

  beforeEach(() => {
    program = make_program();
  });

  it('rejects `stats -s`, naming --site', async () => {
    await expect(
      program.parseAsync(['stats', '-s', 'https://contoso.sharepoint.com/sites/x'], {
        from: 'user',
      }),
    ).rejects.toThrow(/-s no longer means --site/);
  });

  it('rejects `outlook save -o`, naming --output', async () => {
    await expect(
      program.parseAsync(['outlook', 'save', '-s', 'snap-1', '-o', 'export.zip'], { from: 'user' }),
    ).rejects.toThrow(/-o no longer means --output/);
  });

  it('rejects `onedrive save -O`, naming --output', async () => {
    await expect(
      program.parseAsync(
        ['onedrive', 'save', '-o', 'user@example.com', '-s', 'snap-1', '-O', 'export.zip'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/-O no longer means --output/);
  });

  it('still reads -o as the owner on a drive command', () => {
    const save = program.commands
      .find((command) => command.name() === 'onedrive')!
      .commands.find((command) => command.name() === 'save')!;

    expect(save.options.find((option) => option.short === '-o')?.long).toBe('--owner');
  });
});

describe('outlook --folder arity', () => {
  let program: Command;

  beforeEach(() => {
    program = make_program();
  });

  // The flag was variadic on backup and single-valued on restore and save, so one group carried
  // two arities and a variadic `-f` swallowed the next flag's argument.
  it('collects a repeated -f into every named folder', async () => {
    await program.parseAsync(
      ['outlook', 'backup', '-m', 'user@test.com', '-f', 'Inbox', '-f', 'Sent Items'],
      { from: 'user' },
    );

    expect(mock_run_backup.mock.calls[0]![3].folder_filter).toEqual(['Inbox', 'Sent Items']);
  });

  it('does not consume the following flag as another folder', async () => {
    await program.parseAsync(['outlook', 'backup', '-f', 'Inbox', '-m', 'user@test.com'], {
      from: 'user',
    });

    expect(mock_run_backup.mock.calls[0]![3].folder_filter).toEqual(['Inbox']);
    expect(mock_run_backup.mock.calls[0]![2]).toBe('user@test.com');
  });
});
