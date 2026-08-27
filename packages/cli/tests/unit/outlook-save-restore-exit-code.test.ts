import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook.command';
import { RESTORE_USE_CASE_TOKEN, SAVE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * Issue #197, at the layer that had the bug. The handlers set
 * `process.exitCode = 1` for a per-item failure, which pages an operator for an
 * incomplete run, and left an integrity-only failure at 0, which reports an
 * archive missing verified content as a clean success.
 */
function make_save_result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_id: 'snap-1',
    saved_count: 1,
    attachment_count: 0,
    error_count: 0,
    errors: [],
    output_path: '/tmp/out.zip',
    total_bytes: 1024,
    interrupted: false,
    integrity_failures: [],
    ...overrides,
  };
}

function make_restore_result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_id: 'snap-1',
    restored_count: 1,
    attachment_count: 0,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    restore_folder_name: 'Restore-2026',
    interrupted: false,
    ...overrides,
  };
}

describe('outlook save and restore exit codes', () => {
  let container: Container;
  let program: Command;
  let save_mailbox: ReturnType<typeof vi.fn>;
  let restore_snapshot: ReturnType<typeof vi.fn>;
  let previous: typeof process.exitCode;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    save_mailbox = vi.fn().mockResolvedValue(make_save_result());
    restore_snapshot = vi.fn().mockResolvedValue(make_restore_result());

    container = new Container();
    container.bind(SAVE_USE_CASE_TOKEN).toConstantValue({
      save_mailbox,
      save_snapshot: vi.fn().mockResolvedValue(make_save_result()),
    });
    container.bind(RESTORE_USE_CASE_TOKEN).toConstantValue({
      restore_snapshot,
      restore_mailbox: vi.fn().mockResolvedValue(make_restore_result()),
    });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });

    program = new Command();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  const run_save = (): Promise<unknown> =>
    program.parseAsync(['outlook', 'save', '-m', 'john.doe@example.com'], { from: 'user' });

  const run_restore = (): Promise<unknown> =>
    program.parseAsync(['outlook', 'restore', '-s', 'snap-1'], { from: 'user' });

  it('save exits partial, not 1, when some messages failed', async () => {
    save_mailbox.mockResolvedValue(
      make_save_result({ saved_count: 1, error_count: 1, errors: ['message:2 decrypt failed'] }),
    );
    await run_save();
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('save exits non-zero when the only failures are integrity failures', async () => {
    save_mailbox.mockResolvedValue(
      make_save_result({ integrity_failures: ['message:tampered-1'] }),
    );
    await run_save();
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('restore exits partial, not 1, when some messages failed', async () => {
    restore_snapshot.mockResolvedValue(
      make_restore_result({ error_count: 1, errors: ['message:2 create failed'] }),
    );
    await run_restore();
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('leaves a clean save and a clean restore at 0', async () => {
    await run_save();
    expect(process.exitCode).toBeUndefined();

    await run_restore();
    expect(process.exitCode).toBeUndefined();
  });

  it('does not reclassify restore verification warnings as partial', async () => {
    restore_snapshot.mockResolvedValue(
      make_restore_result({ verification_warnings: ['1 older manifest referenced'] }),
    );
    await run_restore();
    expect(process.exitCode).toBeUndefined();
  });
});
