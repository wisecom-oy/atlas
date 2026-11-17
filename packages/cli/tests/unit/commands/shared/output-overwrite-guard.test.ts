import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@wisecom/atlas-core';
import { pipe_stdin } from '@wisecom/atlas-types/testing/piped-stdin';
import { confirm_output_overwrite } from '@/commands/shared/output-overwrite-guard';
import { PromptUnansweredError } from '@/ui/prompt-unanswered-error';

describe('confirm_output_overwrite (issue #736)', () => {
  let work_dir: string;
  let existing_output: string;
  let missing_output: string;
  let restore_stdin: () => void = () => {};

  beforeEach(() => {
    work_dir = mkdtempSync(join(tmpdir(), 'atlas-736-'));
    existing_output = join(work_dir, 'out.zip');
    missing_output = join(work_dir, 'new.zip');
    writeFileSync(existing_output, 'previous archive');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    restore_stdin();
    rmSync(work_dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('asks nothing when no output path is given', async () => {
    restore_stdin = pipe_stdin('');
    await expect(confirm_output_overwrite(undefined)).resolves.toBe(true);
  });

  it('asks nothing when the output path does not exist yet', async () => {
    restore_stdin = pipe_stdin('');
    await expect(confirm_output_overwrite(missing_output)).resolves.toBe(true);
  });

  it('asks nothing when -y skips the question, even with stdin at EOF', async () => {
    restore_stdin = pipe_stdin('');
    await expect(confirm_output_overwrite(existing_output, true)).resolves.toBe(true);
  });

  it('proceeds on a "y" answer', async () => {
    restore_stdin = pipe_stdin('y\n');
    await expect(confirm_output_overwrite(existing_output)).resolves.toBe(true);
  });

  it('defaults to proceeding on a bare Enter', async () => {
    restore_stdin = pipe_stdin('\n');
    await expect(confirm_output_overwrite(existing_output)).resolves.toBe(true);
  });

  it('declines on an "n" answer and logs Cancelled', async () => {
    restore_stdin = pipe_stdin('n\n');
    const info = vi.spyOn(logger, 'info');

    await expect(confirm_output_overwrite(existing_output)).resolves.toBe(false);
    expect(info).toHaveBeenCalledWith('Cancelled.');
  });

  it('throws PromptUnansweredError at EOF instead of settling on a default', async () => {
    restore_stdin = pipe_stdin('');
    await expect(confirm_output_overwrite(existing_output)).rejects.toBeInstanceOf(
      PromptUnansweredError,
    );
  });
});
