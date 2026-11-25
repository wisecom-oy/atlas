import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core';
import { fail_exit_while_command_pending } from '@/adapters/unsettled-command-exit';

/**
 * Issue #859. A command parked on a promise nothing will resolve let Node run out of work and exit
 * 0, with no output and nothing committed. Whatever parks a command in future, the exit must fail.
 */
const GUARD_URL = pathToFileURL(
  fileURLToPath(new URL('../../../src/adapters/unsettled-command-exit.ts', import.meta.url)),
).href;

const CHILD_TIMEOUT_MS = 15_000;

describe('fail_exit_while_command_pending', () => {
  let before_exit: (() => void) | undefined;
  let exit_code_before: typeof process.exitCode;

  beforeEach(() => {
    exit_code_before = process.exitCode;
    before_exit = undefined;
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'beforeExit') before_exit = listener;
      return process;
    }) as typeof process.once);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = exit_code_before;
    vi.restoreAllMocks();
  });

  it('fails the exit and says so when Node runs out of work with the command pending', () => {
    fail_exit_while_command_pending(new Promise(() => undefined));

    before_exit!();

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('before the command finished'),
    );
  });

  it.each([
    ['succeeded', () => Promise.resolve()],
    ['failed', () => Promise.reject(new Error('boom'))],
  ])('leaves the exit code alone for a command that %s', async (_label, command) => {
    const settled = command();
    settled.catch(() => undefined);
    fail_exit_while_command_pending(settled);
    await Promise.resolve();

    before_exit!();

    expect(process.exitCode).toBe(exit_code_before);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('fail_exit_while_command_pending on a real event loop', () => {
  /** Runs a CLI-shaped child whose command is `command_source`, guarded like `cli.ts` guards it. */
  function run_guarded(command_source: string): ReturnType<typeof spawnSync> {
    const script = `
      const { fail_exit_while_command_pending } = await import(${JSON.stringify(GUARD_URL)});
      const command = ${command_source};
      fail_exit_while_command_pending(command);
      command.then(() => console.log('command finished'));
    `;
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
    );
  }

  it('exits 1 instead of 0 when the command is parked on a promise nothing will resolve', () => {
    const child = run_guarded('new Promise(() => {})');

    expect(child.status).toBe(1);
    expect(child.stderr).toContain('before the command finished');
    expect(child.stdout).not.toContain('command finished');
  });

  it('exits 0 for a command that finished', () => {
    const child = run_guarded('new Promise((resolve) => setTimeout(resolve, 10))');

    expect(child.status).toBe(0);
    expect(child.stdout).toContain('command finished');
    expect(child.stderr).toBe('');
  });
});
