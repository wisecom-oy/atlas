import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  AuthError,
  GraphUnavailableError,
  MailboxNotLicensedError,
  STATUS_USE_CASE_TOKEN,
  ThrottledError,
  USER_IDENTITY_RESOLVER_TOKEN,
  type FolderStatus,
  type MailboxStatusResult,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { describe_peek_error } from '@wisecom/atlas-core/services/shared/status-peek-error';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { handle_fatal_error } from '@/fatal-error';

const OWNER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const THROTTLED = describe_peek_error(new ThrottledError('retry budget exhausted'));
const UNAVAILABLE = describe_peek_error(
  new GraphUnavailableError('Graph kept answering 503', { retries: 12, elapsed_ms: 60_000 }),
);
const RESYNC_FAILED = describe_peek_error(new Error('delta resync failed'));

function folder(name: string, overrides: Partial<FolderStatus> = {}): FolderStatus {
  return {
    folder_id: `id-${name}`,
    folder_name: name,
    has_backup: true,
    pending_new: 0,
    pending_removed: 0,
    pending_capped: false,
    is_up_to_date: true,
    ...overrides,
  };
}

function failed(name: string, peek_error: string): FolderStatus {
  return folder(name, { is_up_to_date: false, peek_error });
}

function mailbox(folders: FolderStatus[]): MailboxStatusResult {
  return {
    owner_id: OWNER_ID,
    last_backup_at: new Date('2026-08-01T10:00:00Z'),
    last_snapshot_id: 'snap-1',
    total_folders: folders.length,
    folders,
    is_up_to_date: folders.every((f) => f.is_up_to_date),
    total_pending_changes: folders.reduce((sum, f) => sum + f.pending_new + f.pending_removed, 0),
    pending_capped: false,
  };
}

/** Issue #870: `outlook status` exits non-zero when a folder could not be checked. */
describe('outlook status exit code', () => {
  let previous: typeof process.exitCode;
  let check_mailbox_status: Mock;
  let program: Command;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    check_mailbox_status = vi.fn();
    const container = new Container();
    container.bind(STATUS_USE_CASE_TOKEN).toConstantValue({ check_mailbox_status });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });
    program = new Command();
    program.exitOverride();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  async function run_status(): Promise<void> {
    await program.parseAsync(['outlook', 'status', '-m', OWNER_ID], { from: 'user' });
  }

  it('exits 3 when every folder failed on a throttle or an unavailable Graph', async () => {
    check_mailbox_status.mockResolvedValue(
      mailbox([failed('Inbox', THROTTLED), failed('Sent Items', UNAVAILABLE)]),
    );

    await run_status();

    expect(process.exitCode).toBe(3);
  });

  it('exits 2 when every folder failed and one failure was not transient', async () => {
    check_mailbox_status.mockResolvedValue(
      mailbox([failed('Inbox', THROTTLED), failed('Sent Items', RESYNC_FAILED)]),
    );

    await run_status();

    expect(process.exitCode).toBe(2);
  });

  it('exits 2 when some folders were checked and another failed', async () => {
    check_mailbox_status.mockResolvedValue(
      mailbox([folder('Inbox'), failed('Sent Items', RESYNC_FAILED)]),
    );

    await run_status();

    expect(process.exitCode).toBe(2);
  });

  it('exits 3 when some folders were checked and the rest were throttled', async () => {
    check_mailbox_status.mockResolvedValue(
      mailbox([folder('Inbox'), failed('Archive', THROTTLED)]),
    );

    await run_status();

    expect(process.exitCode).toBe(3);
  });

  it('exits as before when every peek succeeded, pending changes or not', async () => {
    check_mailbox_status.mockResolvedValue(
      mailbox([folder('Inbox'), folder('Sent Items', { pending_new: 3, is_up_to_date: false })]),
    );

    await run_status();

    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['an auth failure', new AuthError('Graph returned 403')],
    ['an unlicensed mailbox', new MailboxNotLicensedError('no Exchange Online licence')],
  ])('still exits 4 on %s', async (_label, error) => {
    check_mailbox_status.mockRejectedValue(error);

    await run_status().catch(handle_fatal_error);

    expect(process.exitCode).toBe(4);
  });
});
