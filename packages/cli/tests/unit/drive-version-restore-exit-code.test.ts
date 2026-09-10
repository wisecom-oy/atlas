import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_onedrive_command } from '@/commands/onedrive.command';
import {
  ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * Issue #362. `restore-version` never set an exit code, so a rollback where every file failed
 * printed a warning and exited 0. A scripted rollback could not tell that from success.
 */
function make_result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    files_restored: 1,
    files_skipped: 0,
    restored: [],
    errors: [],
    placement: 'copy',
    interrupted: false,
    ...overrides,
  };
}

describe('drive restore-version exit codes', () => {
  let container: Container;
  let program: Command;
  let restore_version: ReturnType<typeof vi.fn>;
  let previous: typeof process.exitCode;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    restore_version = vi.fn().mockResolvedValue(make_result());

    container = new Container();
    container
      .bind(ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN)
      .toConstantValue({ restore_onedrive_version: restore_version });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi
        .fn()
        .mockResolvedValue({ object_id: 'owner-1', user_principal_name: 'john.doe@example.com' }),
    });

    program = new Command();
    register_onedrive_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  const run = (): Promise<unknown> =>
    program.parseAsync(
      ['onedrive', 'restore-version', '-o', 'john.doe@example.com', '--before', '2026-03-10'],
      { from: 'user' },
    );

  it('exits 1 when a version restore failed', async () => {
    restore_version.mockResolvedValue(
      make_result({ files_restored: 0, errors: ['/Report.docx: content missing from storage'] }),
    );

    await run();

    expect(process.exitCode).toBe(1);
  });

  it('exits partial when files were skipped without errors', async () => {
    restore_version.mockResolvedValue(make_result({ files_restored: 0, files_skipped: 2 }));

    await run();

    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('reports an error over a skip when both happened', async () => {
    restore_version.mockResolvedValue(
      make_result({ files_skipped: 1, errors: ['/Budget.xlsx: upload refused'] }),
    );

    await run();

    expect(process.exitCode).toBe(1);
  });

  it('leaves a clean rollback at 0', async () => {
    await run();

    expect(process.exitCode).toBeUndefined();
  });
});
