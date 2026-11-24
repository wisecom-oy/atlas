import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { BACKUP_USE_CASE_TOKEN, USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import type { SyncResult } from '@wisecom/atlas-types/ports/backup/use-case.port';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

/**
 * Issue #813. The backup adapter printed every warning and folder error before the counters, and
 * the command printed them again through `report_run_outcome`, so each appeared twice and a folder
 * error appeared once as a warning. This runs the real adapter and the real command together.
 */
vi.mock('@/ui/render', () => ({
  render_static_view: vi.fn(async () => {}),
  mount_live_view: vi.fn(),
}));

const WARNING = 'Deleted Items: message one: stored from the JSON payload';
const FOLDER_ERROR = 'Inbox: message two: original MIME not captured';

function result_with(warnings: string[], folder_errors: string[]): SyncResult {
  return {
    mode: 'incremental',
    snapshot: { id: 'snap-1', object_count: 2 },
    manifest: { total_size_bytes: 10 },
    summary: {
      stored: 2,
      deduplicated: 0,
      attachments_stored: 0,
      processed: 2,
      folder_errors,
      warnings,
      interrupted: false,
      completed_folder_count: 2,
      total_folder_count: 2,
      elapsed_ms: 1000,
      excluded_folders: [],
      reactions_not_captured: 0,
    },
  } as unknown as SyncResult;
}

/** Every line written to stderr through `console.warn` or `console.error`, joined per call. */
function stderr_lines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => call.map(String).join(' '));
}

describe('outlook backup run report (issue #813)', () => {
  let program: Command;
  let sync_mailbox: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let exit_code_before: typeof process.exitCode;

  beforeEach(() => {
    exit_code_before = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    sync_mailbox = vi.fn();
    const container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi.fn().mockResolvedValue({
        object_id: 'owner',
        email: 'john.doe@example.com',
        display_name: 'John Doe',
      }),
    });
    program = new Command();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = exit_code_before;
    vi.restoreAllMocks();
  });

  it('prints one warning and one folder error exactly once each, the error as an error', async () => {
    sync_mailbox.mockResolvedValue(result_with([WARNING], [FOLDER_ERROR]));

    await program.parseAsync(['outlook', 'backup', '-m', 'john.doe@example.com'], {
      from: 'user',
    });

    const warnings = stderr_lines(warn);
    const errors = stderr_lines(error);
    expect(warnings.filter((line) => line.includes(WARNING))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes(FOLDER_ERROR))).toEqual([]);
    expect(errors.filter((line) => line.includes(FOLDER_ERROR))).toEqual([
      expect.stringContaining(`folder error: ${FOLDER_ERROR}`),
    ]);
    expect(process.exitCode).toBe(2);
  });

  it('keeps exit 0 for a run with warnings only, printing each once', async () => {
    sync_mailbox.mockResolvedValue(result_with([WARNING], []));

    await program.parseAsync(['outlook', 'backup', '-m', 'john.doe@example.com'], {
      from: 'user',
    });

    expect(stderr_lines(warn).filter((line) => line.includes(WARNING))).toHaveLength(1);
    expect(stderr_lines(error)).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
