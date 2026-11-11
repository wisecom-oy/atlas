import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import {
  RESTORE_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type OperationControlOptions,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * Issue #682. Outlook restore and save never received the interrupt gate. The services kept SIGINT
 * listeners of their own that only set a flag, so the first Ctrl+C did not end a Graph wait and no
 * number of further presses ended the process.
 */
const restore_partial = {
  snapshot_id: 'snap-1',
  restored_count: 2,
  attachment_count: 0,
  error_count: 0,
  attachment_error_count: 0,
  errors: [],
  verification_warnings: [],
  messages: [],
  restore_folder_name: 'Restore-2026',
  interrupted: true,
};

const save_partial = {
  snapshot_id: 'snap-1',
  saved_count: 2,
  attachment_count: 0,
  error_count: 0,
  errors: [],
  output_path: 'out.zip',
  total_bytes: 1024,
  integrity_failures: [],
  interrupted: true,
};

interface Case {
  readonly name: string;
  readonly token: symbol;
  readonly method: string;
  readonly argv: string[];
  readonly partial: Record<string, unknown>;
}

const cases: Case[] = [
  {
    name: 'outlook restore -s',
    token: RESTORE_USE_CASE_TOKEN,
    method: 'restore_snapshot',
    argv: ['outlook', 'restore', '-s', 'snap-1'],
    partial: restore_partial,
  },
  {
    name: 'outlook restore -m',
    token: RESTORE_USE_CASE_TOKEN,
    method: 'restore_mailbox',
    argv: ['outlook', 'restore', '-m', 'john.doe@example.com'],
    partial: restore_partial,
  },
  {
    name: 'outlook save -s',
    token: SAVE_USE_CASE_TOKEN,
    method: 'save_snapshot',
    argv: ['outlook', 'save', '-s', 'snap-1', '--output', 'out.zip'],
    partial: save_partial,
  },
];

/** A run that holds until its abort signal fires, then reports the messages it got through. */
function run_parked_until_aborted(partial: Record<string, unknown>): Mock {
  return vi.fn(
    (_tenant: string, _scope: string, options: OperationControlOptions) =>
      new Promise((resolve) => {
        options.abort_signal?.addEventListener('abort', () => resolve(partial));
      }),
  );
}

function build_program(test_case: Case, run: Mock): Command {
  const container = new Container();
  container.bind(test_case.token).toConstantValue({ [test_case.method]: run });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
    resolve_user: vi.fn().mockResolvedValue({ object_id: 'owner-1', display_name: 'John Doe' }),
  });
  const program = new Command();
  register_outlook_command(program, () => container);
  return program;
}

describe.each(cases)('$name Ctrl+C (issue #682)', (test_case) => {
  let exit: ReturnType<typeof vi.spyOn>;
  let previous: typeof process.exitCode;
  let output: string[];
  let sigint_listeners: number;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    output = [];
    sigint_listeners = process.listenerCount('SIGINT');
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const capture = (...args: unknown[]): void => void output.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  it('aborts the signal on the first Ctrl+C, reports the partial run, and exits partial', async () => {
    const service = run_parked_until_aborted(test_case.partial);
    const run = build_program(test_case, service).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(service).toHaveBeenCalled());

    process.emit('SIGINT');
    await run;

    const options = service.mock.calls[0]![2] as OperationControlOptions;
    expect(options.abort_signal?.aborted).toBe(true);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
    expect(exit).not.toHaveBeenCalled();
    expect(output.join('\n')).toMatch(/2 messages/);
    expect(process.listenerCount('SIGINT')).toBe(sigint_listeners);
  });

  it('exits with 130 on the second Ctrl+C even while the run ignores the first', async () => {
    let finish: (result: unknown) => void = () => undefined;
    const service = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const run = build_program(test_case, service).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(service).toHaveBeenCalled());

    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    process.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
    finish(test_case.partial);
    await run;
  });
});
