import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { DELETION_USE_CASE_TOKEN, SAVE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { pipe_stdin } from '@wisecom/atlas-types/testing/piped-stdin';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { register_tenant_delete_command } from '@/commands/tenant/delete.command';
import { handle_fatal_error } from '@/fatal-error';
import { PromptUnansweredError } from '@/ui/prompt-unanswered-error';

/**
 * Issue #706, through the real prompt. With stdin at EOF the prompt used to stay pending, the
 * event loop drained, and the command exited 0 having skipped its work. It must now fail before
 * the guarded work and exit non-zero.
 */
const DELETE_RESULT = {
  deleted_objects: 1,
  deleted_manifests: 1,
  retained_objects: 0,
  retained_manifests: 0,
  failed_objects: 0,
  failed_manifests: 0,
};

describe('confirmation prompts with stdin at EOF (issue #706)', () => {
  let program: Command;
  let save_snapshot: Mock;
  let deletion: { delete_snapshot: Mock; purge_tenant: Mock };
  let work_dir: string;
  let existing_output: string;
  let restore_stdin: () => void = () => {};

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    work_dir = mkdtempSync(join(tmpdir(), 'atlas-706-'));
    existing_output = join(work_dir, 'out.zip');
    writeFileSync(existing_output, 'previous archive');

    save_snapshot = vi.fn().mockResolvedValue({
      snapshot_id: 'snap-1',
      saved_count: 1,
      attachment_count: 0,
      error_count: 0,
      errors: [],
      output_path: existing_output,
      total_bytes: 1,
      interrupted: false,
      integrity_failures: [],
    });
    deletion = {
      delete_snapshot: vi.fn().mockResolvedValue(DELETE_RESULT),
      purge_tenant: vi.fn().mockResolvedValue(DELETE_RESULT),
    };

    const container = new Container();
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(SAVE_USE_CASE_TOKEN).toConstantValue({ save_snapshot, save_mailbox: vi.fn() });
    container.bind(DELETION_USE_CASE_TOKEN).toConstantValue(deletion);
    program = new Command();
    register_outlook_command(program, () => container);
    register_tenant_delete_command(program, () => container);
  });

  afterEach(() => {
    restore_stdin();
    rmSync(work_dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const run = (args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

  it('refuses to overwrite an existing save output and does not save', async () => {
    restore_stdin = pipe_stdin('');
    const run_save = run(['outlook', 'save', '-s', 'snap-1', '--output', existing_output]);

    await expect(run_save).rejects.toBeInstanceOf(PromptUnansweredError);
    expect(save_snapshot).not.toHaveBeenCalled();
  });

  it('overwrites an existing save output without asking when -y is given', async () => {
    restore_stdin = pipe_stdin('');
    await run(['outlook', 'save', '-s', 'snap-1', '--output', existing_output, '-y']);

    expect(save_snapshot).toHaveBeenCalledTimes(1);
  });

  it('deletes no snapshot when the delete prompt reads EOF', async () => {
    restore_stdin = pipe_stdin('');
    const run_delete = run(['outlook', 'delete', '-s', 'snap-1']);

    await expect(run_delete).rejects.toBeInstanceOf(PromptUnansweredError);
    expect(deletion.delete_snapshot).not.toHaveBeenCalled();
  });

  it('purges nothing when the typed tenant confirmation reads EOF', async () => {
    restore_stdin = pipe_stdin('');
    const run_purge = run(['delete', '--purge']);

    await expect(run_purge).rejects.toBeInstanceOf(PromptUnansweredError);
    expect(deletion.purge_tenant).not.toHaveBeenCalled();
  });

  it('still deletes on a piped "y" answer', async () => {
    restore_stdin = pipe_stdin('y\n');
    await run(['outlook', 'delete', '-s', 'snap-1']);

    expect(deletion.delete_snapshot).toHaveBeenCalledWith('tenant-1', 'snap-1');
  });

  it('exits 1 with the unanswered prompt named and -y suggested', async () => {
    const error_spy = vi.mocked(console.error);
    handle_fatal_error(new PromptUnansweredError());

    expect(process.exitCode).toBe(1);
    const printed = error_spy.mock.calls.flat().join('\n');
    expect(printed).toContain('No answer was read at the confirmation prompt');
    expect(printed).toContain('-y');
  });
});
