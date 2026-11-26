import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import {
  CALENDAR_RESTORE_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type OperationControlOptions,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_calendar_command } from '@/commands/calendar/calendar.command';
import { register_contacts_command } from '@/commands/contacts/contacts.command';

/**
 * Issue #879. Calendar and Contacts creates now finish once sent, so the first Ctrl+C waits for the
 * write on the wire. The second Ctrl+C must still end the process at once with 130.
 */
interface Case {
  readonly name: string;
  readonly token: symbol;
  readonly method: string;
  readonly argv: string[];
}

const cases: Case[] = [
  {
    name: 'calendar restore',
    token: CALENDAR_RESTORE_USE_CASE_TOKEN,
    method: 'restore_calendar',
    argv: ['calendar', 'restore', '-m', 'john.doe@example.com', '-s', 'cal-snap-1'],
  },
  {
    name: 'contacts restore',
    token: CONTACTS_RESTORE_USE_CASE_TOKEN,
    method: 'restore_contacts',
    argv: ['contacts', 'restore', '-m', 'john.doe@example.com', '-s', 'ct-snap-1'],
  },
];

function build_program(test_case: Case, run: Mock): Command {
  const container = new Container();
  container.bind(test_case.token).toConstantValue({ [test_case.method]: run });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
    resolve_user: vi.fn().mockResolvedValue({ object_id: 'owner-1', display_name: 'John Doe' }),
  });
  const program = new Command();
  register_calendar_command(program, () => container);
  register_contacts_command(program, () => container);
  return program;
}

describe.each(cases)('$name with a write on the wire (issue #879)', (test_case) => {
  let exit: ReturnType<typeof vi.spyOn>;
  let previous: typeof process.exitCode;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  it('waits on the first Ctrl+C and exits with 130 on the second', async () => {
    let finish: (result: unknown) => void = () => undefined;
    // Holds past the abort the way a create left to finish does.
    const service = vi.fn(
      (_tenant: string, _mailbox: string, _options: OperationControlOptions) =>
        new Promise((resolve) => (finish = resolve)),
    );
    const run = build_program(test_case, service).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(service).toHaveBeenCalled());

    process.emit('SIGINT');
    const options = service.mock.calls[0]![2];
    expect(options.abort_signal?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    process.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
    finish({ snapshot_id: 'snap-1', errors: [], interrupted: true });
    await run;
  });
});
