import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook.command';
import {
  CATALOG_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

/**
 * Issue #201 at the layer that had the bug. A resolver nobody calls fixes nothing, so these drive
 * the real commander wiring and assert which use-case method each invocation reaches.
 */
const SNAPSHOT = 'snap-example-1';
const MAILBOX = 'john.doe@example.com';
const TARGET = 'jane.roe@example.com';

function save_result(): Record<string, unknown> {
  return {
    snapshot_id: SNAPSHOT,
    saved_count: 1,
    attachment_count: 0,
    error_count: 0,
    errors: [],
    output_path: '/tmp/out.zip',
    total_bytes: 1,
    interrupted: false,
    integrity_failures: [],
  };
}

function restore_result(): Record<string, unknown> {
  return {
    snapshot_id: SNAPSHOT,
    restored_count: 1,
    attachment_count: 0,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    restore_folder_name: 'Restore-2026',
    interrupted: false,
  };
}

describe('outlook subcommand scope precedence', () => {
  let container: Container;
  let program: Command;
  let save_snapshot: ReturnType<typeof vi.fn>;
  let save_mailbox: ReturnType<typeof vi.fn>;
  let restore_snapshot: ReturnType<typeof vi.fn>;
  let restore_mailbox: ReturnType<typeof vi.fn>;
  let list_snapshot_messages: ReturnType<typeof vi.fn>;
  let list_mailbox_snapshots: ReturnType<typeof vi.fn>;
  let exit_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    save_snapshot = vi.fn().mockResolvedValue(save_result());
    save_mailbox = vi.fn().mockResolvedValue(save_result());
    restore_snapshot = vi.fn().mockResolvedValue(restore_result());
    restore_mailbox = vi.fn().mockResolvedValue(restore_result());
    list_snapshot_messages = vi.fn().mockResolvedValue({ snapshot_id: SNAPSHOT, entries: [] });
    list_mailbox_snapshots = vi.fn().mockResolvedValue([]);

    container = new Container();
    container.bind(SAVE_USE_CASE_TOKEN).toConstantValue({
      save_snapshot,
      save_mailbox,
    });
    container.bind(RESTORE_USE_CASE_TOKEN).toConstantValue({
      restore_snapshot,
      restore_mailbox,
    });
    container.bind(CATALOG_USE_CASE_TOKEN).toConstantValue({
      get_snapshot_detail: list_snapshot_messages,
      list_snapshots: list_mailbox_snapshots,
      list_mailboxes: vi.fn().mockResolvedValue([]),
      read_message: vi.fn(),
    });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });

    program = new Command();
    program.exitOverride();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (args: string[]): Promise<unknown> =>
    program.parseAsync(['outlook', ...args], { from: 'user' });

  describe('save', () => {
    it('exports the named snapshot when -s and -m are both passed', async () => {
      await run(['save', '-s', SNAPSHOT, '-m', MAILBOX]);

      expect(save_snapshot).toHaveBeenCalledTimes(1);
      expect(save_mailbox).not.toHaveBeenCalled();
    });

    it('still exports the whole mailbox when only -m is passed', async () => {
      await run(['save', '-m', MAILBOX]);

      expect(save_mailbox).toHaveBeenCalledTimes(1);
      expect(save_snapshot).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('refuses -s together with -m rather than guessing a target mailbox', async () => {
      await expect(run(['restore', '-s', SNAPSHOT, '-m', TARGET])).rejects.toThrow();

      expect(exit_spy).toHaveBeenCalledWith(1);
      expect(restore_snapshot).not.toHaveBeenCalled();
      expect(restore_mailbox).not.toHaveBeenCalled();
    });

    it('redirects a snapshot restore with -T', async () => {
      await run(['restore', '-s', SNAPSHOT, '-T', TARGET]);

      expect(restore_snapshot).toHaveBeenCalledTimes(1);
      const options = restore_snapshot.mock.calls[0]?.[2] as { target_mailbox?: string };
      expect(options.target_mailbox).toBe(TARGET);
    });

    it('restores to the original mailbox when no -T is given', async () => {
      await run(['restore', '-s', SNAPSHOT]);

      const options = restore_snapshot.mock.calls[0]?.[2] as { target_mailbox?: string };
      expect(options.target_mailbox).toBeUndefined();
    });
  });

  describe('list', () => {
    it('shows the snapshot when -s and -m are both passed', async () => {
      await run(['list', '-s', SNAPSHOT, '-m', MAILBOX]);

      expect(list_snapshot_messages).toHaveBeenCalledTimes(1);
      expect(list_mailbox_snapshots).not.toHaveBeenCalled();
    });
  });
});
