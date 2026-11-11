import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import {
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_VERSION_RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type OperationControlOptions,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * Issue #682. The OneDrive and SharePoint `restore` and `restore-version` commands installed no
 * interrupt gate, so the first Ctrl+C killed the process mid-file with exit 130 and no report of
 * the files already restored, and the services never saw an abort signal.
 */
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

const snapshot_partial = {
  snapshot_id: 'snap-1',
  files_restored: 2,
  folders_created: 1,
  files_skipped: 0,
  errors: [],
  interrupted: true,
};

const version_partial = {
  files_restored: 2,
  files_skipped: 0,
  restored: [],
  errors: [],
  placement: 'copy',
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
    name: 'onedrive restore',
    token: ONEDRIVE_RESTORE_USE_CASE_TOKEN,
    method: 'restore_onedrive',
    argv: ['onedrive', 'restore', '-o', 'john.doe@example.com', '-s', 'snap-1'],
    partial: snapshot_partial,
  },
  {
    name: 'sharepoint restore',
    token: SHAREPOINT_RESTORE_USE_CASE_TOKEN,
    method: 'restore_sharepoint',
    argv: ['sharepoint', 'restore', '--site', SITE_ID, '-s', 'snap-1'],
    partial: snapshot_partial,
  },
  {
    name: 'onedrive restore-version',
    token: ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN,
    method: 'restore_onedrive_version',
    argv: ['onedrive', 'restore-version', '-o', 'john.doe@example.com', '--before', '2026-03-10'],
    partial: version_partial,
  },
  {
    name: 'sharepoint restore-version',
    token: SHAREPOINT_VERSION_RESTORE_USE_CASE_TOKEN,
    method: 'restore_sharepoint_version',
    argv: ['sharepoint', 'restore-version', '--site', SITE_ID, '--before', '2026-03-10'],
    partial: version_partial,
  },
];

/** A restore that holds until its abort signal fires, then reports the files it got through. */
function restore_parked_until_aborted(partial: Record<string, unknown>): Mock {
  return vi.fn(
    (_tenant: string, _owner: string, options: OperationControlOptions) =>
      new Promise((resolve) => {
        options.abort_signal?.addEventListener('abort', () => resolve(partial));
      }),
  );
}

function build_program(test_case: Case, restore: Mock): Command {
  const container = new Container();
  container.bind(test_case.token).toConstantValue({ [test_case.method]: restore });
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
    resolve_user: vi.fn().mockResolvedValue({ object_id: 'owner-1', display_name: 'John Doe' }),
  });
  const program = new Command();
  register_onedrive_command(program, () => container);
  register_sharepoint_command(program, () => container);
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

  it('stops on the first Ctrl+C, reports the files restored so far, and exits partial', async () => {
    const restore = restore_parked_until_aborted(test_case.partial);
    const run = build_program(test_case, restore).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(restore).toHaveBeenCalled());

    process.emit('SIGINT');
    await run;

    const options = restore.mock.calls[0]![2] as OperationControlOptions;
    expect(options.abort_signal?.aborted).toBe(true);
    expect(options.should_interrupt?.()).toBe(true);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
    expect(exit).not.toHaveBeenCalled();
    expect(output.join('\n')).toMatch(/2/);
    expect(output.join('\n')).toMatch(/interrupted/i);
    expect(process.listenerCount('SIGINT')).toBe(sigint_listeners);
  });

  it('exits with 130 on the second Ctrl+C even while the restore ignores the first', async () => {
    let finish: (result: unknown) => void = () => undefined;
    const restore = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const run = build_program(test_case, restore).parseAsync(test_case.argv, { from: 'user' });
    await vi.waitFor(() => expect(restore).toHaveBeenCalled());

    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    process.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
    finish(test_case.partial);
    await run;
  });
});
