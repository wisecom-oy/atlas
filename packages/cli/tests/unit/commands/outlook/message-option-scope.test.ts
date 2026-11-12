import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import {
  RESTORE_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

/**
 * Issue #705: `--message` with `-m` was accepted and dropped, so `save` and `restore` acted on the
 * whole mailbox. It is refused now before the mailbox is resolved or any use case runs.
 */
const SNAPSHOT = 'snap-example-1';
const MAILBOX = 'john.doe@example.com';

const SAVE_RESULT = {
  snapshot_id: SNAPSHOT,
  saved_count: 1,
  attachment_count: 0,
  error_count: 0,
  errors: [],
  output_path: 'out.zip',
  total_bytes: 1,
  interrupted: false,
  integrity_failures: [],
};

describe('outlook --message scope', () => {
  let program: Command;
  let save_snapshot: ReturnType<typeof vi.fn>;
  let save_mailbox: ReturnType<typeof vi.fn>;
  let restore_snapshot: ReturnType<typeof vi.fn>;
  let restore_mailbox: ReturnType<typeof vi.fn>;
  let resolve_user: ReturnType<typeof vi.fn>;
  let exit_spy: ReturnType<typeof vi.spyOn>;
  let error_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    save_snapshot = vi.fn().mockResolvedValue(SAVE_RESULT);
    save_mailbox = vi.fn().mockResolvedValue(SAVE_RESULT);
    restore_snapshot = vi.fn();
    restore_mailbox = vi.fn();
    resolve_user = vi.fn().mockResolvedValue({ object_id: 'owner-1', email: MAILBOX });

    const container = new Container();
    container.bind(SAVE_USE_CASE_TOKEN).toConstantValue({ save_snapshot, save_mailbox });
    container.bind(RESTORE_USE_CASE_TOKEN).toConstantValue({ restore_snapshot, restore_mailbox });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user });

    program = new Command();
    program.exitOverride();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (args: string[]): Promise<unknown> =>
    program.parseAsync(['outlook', ...args], { from: 'user' });

  const logged_errors = (): string =>
    error_spy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

  // An empty value is still a supplied flag: `--message ''` used to slip past a truthiness check.
  it.each(['1', ''])(
    'refuses save -m with --message %j before resolving the mailbox',
    async (message) => {
      await expect(run(['save', '-m', MAILBOX, '--message', message])).rejects.toThrow(
        'process.exit',
      );

      expect(exit_spy).toHaveBeenCalledWith(1);
      expect(logged_errors()).toContain('--message selects a message inside one snapshot');
      expect(resolve_user).not.toHaveBeenCalled();
      expect(save_mailbox).not.toHaveBeenCalled();
      expect(save_snapshot).not.toHaveBeenCalled();
    },
  );

  it.each(['1', ''])(
    'refuses restore -m with --message %j before resolving the mailbox',
    async (message) => {
      await expect(run(['restore', '-m', MAILBOX, '--message', message])).rejects.toThrow(
        'process.exit',
      );

      expect(exit_spy).toHaveBeenCalledWith(1);
      expect(logged_errors()).toContain('needs --snapshot (-s)');
      expect(resolve_user).not.toHaveBeenCalled();
      expect(restore_mailbox).not.toHaveBeenCalled();
      expect(restore_snapshot).not.toHaveBeenCalled();
    },
  );

  it('saves the one message when save gets -s and -m with --message', async () => {
    await run(['save', '-s', SNAPSHOT, '-m', MAILBOX, '--message', '1']);

    expect(save_mailbox).not.toHaveBeenCalled();
    expect(save_snapshot).toHaveBeenCalledTimes(1);
    expect(save_snapshot.mock.calls[0]?.[2]).toMatchObject({ message_ref: '1' });
  });
});
