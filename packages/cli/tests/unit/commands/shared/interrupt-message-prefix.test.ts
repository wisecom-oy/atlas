import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import {
  BACKUP_USE_CASE_TOKEN,
  CALENDAR_BACKUP_USE_CASE_TOKEN,
  CALENDAR_RESTORE_USE_CASE_TOKEN,
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type OperationControlOptions,
} from '@wisecom/atlas-types';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { register_calendar_command } from '@/commands/calendar/calendar.command';
import { register_contacts_command } from '@/commands/contacts/contacts.command';

/**
 * Issue #692. The interrupt gate logs its message with `logger.warn`, which adds `[!]`. The Outlook
 * backup and the Calendar and Contacts messages carried their own `[!]`, so the first Ctrl+C
 * printed `[!] [!] Stopping ...`.
 */
interface Case {
  readonly name: string;
  readonly register: (program: Command, get_container: () => Container) => void;
  readonly token: symbol;
  readonly method: string;
  readonly argv: string[];
}

const cases: Case[] = [
  {
    name: 'outlook backup',
    register: register_outlook_command,
    token: BACKUP_USE_CASE_TOKEN,
    method: 'sync_mailbox',
    argv: ['outlook', 'backup', '-m', 'john.doe@example.com'],
  },
  {
    name: 'calendar backup',
    register: register_calendar_command,
    token: CALENDAR_BACKUP_USE_CASE_TOKEN,
    method: 'backup_calendar',
    argv: ['calendar', 'backup', '-m', 'john.doe@example.com'],
  },
  {
    name: 'calendar restore',
    register: register_calendar_command,
    token: CALENDAR_RESTORE_USE_CASE_TOKEN,
    method: 'restore_calendar',
    argv: ['calendar', 'restore', '-m', 'john.doe@example.com', '-s', 'snap-1'],
  },
  {
    name: 'contacts backup',
    register: register_contacts_command,
    token: CONTACTS_BACKUP_USE_CASE_TOKEN,
    method: 'backup_contacts',
    argv: ['contacts', 'backup', '-m', 'john.doe@example.com'],
  },
  {
    name: 'contacts restore',
    register: register_contacts_command,
    token: CONTACTS_RESTORE_USE_CASE_TOKEN,
    method: 'restore_contacts',
    argv: ['contacts', 'restore', '-m', 'john.doe@example.com', '-s', 'snap-1'],
  },
];

/** A run parked in a wait that ends only when the gate's signal aborts. */
function run_parked_until_aborted(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_tenant: string, _owner: string, options: OperationControlOptions) =>
      new Promise((_resolve, reject) => {
        options.abort_signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
  );
}

function build_program(test_case: Case, run: ReturnType<typeof vi.fn>): Command {
  const container = new Container();
  container.bind(test_case.token).toConstantValue({ [test_case.method]: run });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
    resolve_user: vi.fn().mockResolvedValue({ object_id: 'owner-1', display_name: 'John Doe' }),
  });
  const program = new Command();
  test_case.register(program, () => container);
  return program;
}

describe.each(cases)('$name Ctrl+C message (issue #692)', (test_case) => {
  let previous_exit_code: typeof process.exitCode;
  let warnings: string[];

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    process.exitCode = undefined;
    warnings = [];
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous_exit_code;
    vi.restoreAllMocks();
  });

  it('logs the stopping line with exactly one [!] marker', async () => {
    const service = run_parked_until_aborted();
    const run = build_program(test_case, service).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(service).toHaveBeenCalled());

    process.emit('SIGINT');
    await run;

    const stopping = warnings.filter((line) => line.includes('Stopping'));
    expect(stopping).toHaveLength(1);
    expect(stopping[0]!.match(/\[!\]/g)).toHaveLength(1);
    expect(stopping[0]).toMatch(/^\[!\] Stopping/);
  });
});
