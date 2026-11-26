import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { handle_fatal_error } from '@/fatal-error';
import {
  BACKUP_USE_CASE_TOKEN,
  GraphUnavailableError,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import type { SyncResult } from '@wisecom/atlas-types/ports/backup/use-case.port';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

/**
 * Issue #869. A backup whose every folder failed because Microsoft Graph was unavailable exited 2,
 * like one failed message. It now rejects with the outage and exits 3, naming the Atlas code, while
 * a folder that failed for another reason still exits 2 with its code on the folder line.
 */
vi.mock('@/ui/render', () => ({
  render_static_view: vi.fn(async () => {}),
  mount_live_view: vi.fn(),
}));

const REFUSED_LINE = 'Folder 3: Graph refused the folder (Atlas code: ATLAS_ACCESS_REFUSED)';

function partial_result(): SyncResult {
  return {
    mode: 'incremental',
    snapshot: { id: 'snap-1', object_count: 2 },
    manifest: { total_size_bytes: 10 },
    summary: {
      stored: 2,
      deduplicated: 0,
      attachments_stored: 0,
      processed: 2,
      folder_errors: [REFUSED_LINE],
      folder_failures: [],
      warnings: [],
      interrupted: false,
      completed_folder_count: 2,
      total_folder_count: 3,
      elapsed_ms: 1000,
      excluded_folders: [],
      reactions_not_captured: 0,
    },
  } as unknown as SyncResult;
}

function output_of(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')))
    .join('\n');
}

describe('outlook backup exit code for failed folders (issue #869)', () => {
  let program: Command;
  let sync_mailbox: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let exit_code_before: typeof process.exitCode;

  beforeEach(() => {
    exit_code_before = process.exitCode;
    process.exitCode = undefined;
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sync_mailbox = vi.fn();
    const container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi
        .fn()
        .mockResolvedValue({ object_id: 'owner', email: 'john.doe@example.com' }),
    });
    program = new Command();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = exit_code_before;
    vi.restoreAllMocks();
  });

  it('exits 3 and names ATLAS_GRAPH_UNAVAILABLE when the outage stopped the run', async () => {
    sync_mailbox.mockRejectedValue(
      new GraphUnavailableError(
        'Microsoft Graph was unavailable after 12 retries over 1411 s: HTTP 503',
        { retries: 12, elapsed_ms: 1_411_000 },
        { status_code: 503, partial_result: partial_result() },
      ),
    );

    const failure = await program
      .parseAsync(['outlook', 'backup', '-m', 'john.doe@example.com'], { from: 'user' })
      .catch((err: unknown) => err);
    handle_fatal_error(failure);

    expect(process.exitCode).toBe(3);
    expect(output_of(error)).toContain('Atlas code: ATLAS_GRAPH_UNAVAILABLE');
    expect(output_of(log, error)).not.toContain('Run incomplete');
  });

  it('exits 2 for a folder that failed for another reason, naming its code', async () => {
    sync_mailbox.mockResolvedValue(partial_result());

    await program.parseAsync(['outlook', 'backup', '-m', 'john.doe@example.com'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(2);
    expect(output_of(error)).toContain(`folder error: ${REFUSED_LINE}`);
  });
});
