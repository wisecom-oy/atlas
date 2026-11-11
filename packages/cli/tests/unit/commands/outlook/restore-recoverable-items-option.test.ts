import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { RESTORE_USE_CASE_TOKEN, USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

/** Issue #691: `atlas outlook restore --include-recoverable-items` reaches the use case in every mode. */
const SNAPSHOT = 'snap-example-1';
const MAILBOX = 'john.doe@example.com';
const MAILBOX_OBJECT_ID = '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e';

function restore_result(): Record<string, unknown> {
  return {
    snapshot_id: SNAPSHOT,
    restored_count: 1,
    attachment_count: 0,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    restore_folder_name: 'Restore-2026-03-01',
    interrupted: false,
  };
}

describe('outlook restore --include-recoverable-items', () => {
  let program: Command;
  let restore_snapshot: ReturnType<typeof vi.fn>;
  let restore_mailbox: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    restore_snapshot = vi.fn().mockResolvedValue(restore_result());
    restore_mailbox = vi.fn().mockResolvedValue(restore_result());

    const container = new Container();
    container.bind(RESTORE_USE_CASE_TOKEN).toConstantValue({ restore_snapshot, restore_mailbox });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi.fn().mockResolvedValue({
        object_id: MAILBOX_OBJECT_ID,
        email: MAILBOX,
        display_name: 'John Doe',
      }),
    });

    program = new Command();
    program.exitOverride();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (args: string[]): Promise<unknown> =>
    program.parseAsync(['outlook', 'restore', ...args], { from: 'user' });

  it('passes the flag in snapshot mode', async () => {
    await run(['-s', SNAPSHOT, '--include-recoverable-items']);

    expect(restore_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      SNAPSHOT,
      expect.objectContaining({ include_recoverable_items: true }),
    );
  });

  it('passes the flag in single-message mode alongside the destination', async () => {
    await run([
      '-s',
      SNAPSHOT,
      '--message',
      '3',
      '--include-recoverable-items',
      '--destination',
      'Recovered',
    ]);

    expect(restore_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      SNAPSHOT,
      expect.objectContaining({
        message_ref: '3',
        include_recoverable_items: true,
        destination: 'Recovered',
      }),
    );
  });

  it('passes the flag in mailbox mode', async () => {
    await run(['-m', MAILBOX, '--include-recoverable-items']);

    expect(restore_mailbox).toHaveBeenCalledWith(
      'tenant-1',
      MAILBOX_OBJECT_ID,
      expect.objectContaining({ include_recoverable_items: true }),
    );
  });

  it('sends no flag in snapshot mode when it is absent, keeping the default exclusion', async () => {
    await run(['-s', SNAPSHOT, '--message', '3']);

    expect(restore_snapshot.mock.calls[0]?.[2]).not.toHaveProperty('include_recoverable_items');
  });
});
