import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackupUseCase,
  SyncOptions,
  SyncResult,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import {
  OUTLOOK_INTERRUPT_MESSAGE,
  run_backup_with_cli_adapter,
} from '@/adapters/backup-operation.adapter';
import { run_interruptible } from '@/adapters/interruptible-run';

/**
 * Issue #673: the Outlook backup kept its own SIGINT listener with no abort signal. The first
 * Ctrl+C only set a flag polled at page boundaries, and the second set another one, so a run parked
 * in a Graph retry wait ignored any number of presses until the wait ran out.
 */
function use_case(sync_mailbox: (options: SyncOptions) => Promise<SyncResult>): BackupUseCase {
  return { sync_mailbox: (_tenant, _mailbox, options) => sync_mailbox(options ?? {}) };
}

function run_outlook_backup(backup: BackupUseCase): Promise<SyncResult | undefined> {
  return run_interruptible(new Container(), OUTLOOK_INTERRUPT_MESSAGE, (gate) =>
    run_backup_with_cli_adapter(backup, 'tenant-1', 'mailbox-1', {}, gate),
  );
}

describe('Outlook backup Ctrl+C', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let previous_exit_code: typeof process.exitCode;

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous_exit_code;
    vi.restoreAllMocks();
  });

  it('aborts the signal the backup holds on the first Ctrl+C, ending a wait inside it', async () => {
    let received: AbortSignal | undefined;
    const backup = use_case(
      (options) =>
        new Promise((_resolve, reject) => {
          received = options.abort_signal;
          options.abort_signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        }),
    );

    const run = run_outlook_backup(backup);
    process.emit('SIGINT');

    await expect(run).resolves.toBeUndefined();
    expect(received?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits with 130 on the second Ctrl+C even while the backup ignores the first', async () => {
    let finish: (result: SyncResult) => void = () => undefined;
    const backup = use_case(() => new Promise((resolve) => (finish = resolve)));

    const run = run_outlook_backup(backup);
    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    process.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
    finish(interrupted_result());
    await run;
  });
});

function interrupted_result(): SyncResult {
  return {
    mode: 'incremental',
    interrupted: true,
    summary: {
      stored: 0,
      deduplicated: 0,
      attachments_stored: 0,
      processed: 0,
      folder_errors: [],
      warnings: [],
      interrupted: true,
      completed_folder_count: 0,
      total_folder_count: 1,
      elapsed_ms: 0,
      excluded_folders: [],
      reactions_not_captured: 0,
    },
  } as unknown as SyncResult;
}
