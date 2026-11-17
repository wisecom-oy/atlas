import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import { BACKUP_USE_CASE_TOKEN, USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import type { SyncResult } from '@wisecom/atlas-types/ports/backup/use-case.port';
import { register_outlook_command } from '@/commands/outlook/outlook.command';

/**
 * Issue #673 follow-up: a Ctrl+C during the first Graph calls (the mailbox check or the folder
 * listing) makes the service return a placeholder result that was never stored. The presenter
 * printed `No prior backup found – running initial full sync` and `Snapshot <id> -- 0 objects`
 * for it, a success line for a snapshot that does not exist.
 */
function interrupted_before_any_folder(): SyncResult {
  return {
    snapshot: { id: 'placeholder-snapshot' },
    manifest: { total_objects: 0, total_size_bytes: 0 },
    mode: 'initial',
    interrupted: true,
    snapshot_stored: false,
    summary: {
      stored: 0,
      deduplicated: 0,
      attachments_stored: 0,
      processed: 0,
      folder_errors: [],
      warnings: [],
      interrupted: true,
      completed_folder_count: 0,
      total_folder_count: 0,
      elapsed_ms: 0,
      excluded_folders: [],
      reactions_not_captured: 0,
    },
  } as unknown as SyncResult;
}

describe('outlook backup interrupted before any folder was read', () => {
  let program: Command;
  let exit_code_before: typeof process.exitCode;
  let printed: string[];

  beforeEach(() => {
    const container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({
      sync_mailbox: vi.fn().mockResolvedValue(interrupted_before_any_folder()),
    });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-from-config' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi.fn().mockResolvedValue({
        object_id: 'owner-1',
        email: 'user@example.com',
        display_name: 'Example User',
      }),
    });
    program = new Command();
    register_outlook_command(program, () => container);

    printed = [];
    const capture = (line: unknown): void => void printed.push(String(line));
    for (const level of ['info', 'warn', 'error', 'success'] as const) {
      vi.spyOn(logger, level).mockImplementation(capture);
    }
    exit_code_before = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = exit_code_before;
    vi.restoreAllMocks();
  });

  it('prints no snapshot or sync-mode line, says nothing was saved, and exits 2', async () => {
    await program.parseAsync(['outlook', 'backup', '-m', 'user@example.com'], { from: 'user' });

    expect(printed.some((line) => line.includes('placeholder-snapshot'))).toBe(false);
    expect(printed.some((line) => line.includes('initial full sync'))).toBe(false);
    expect(printed.some((line) => line.includes('progress saved'))).toBe(false);
    expect(printed).toContain(
      'Interrupted before any folder was read. Nothing was backed up and no snapshot was saved.',
    );
    expect(process.exitCode).toBe(2);
  });
});
