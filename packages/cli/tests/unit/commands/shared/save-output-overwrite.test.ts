import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import {
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  TEAMS_SAVE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { pipe_stdin } from '@wisecom/atlas-types/testing/piped-stdin';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';
import { register_teams_command } from '@/commands/teams/teams.command';
import { PromptUnansweredError } from '@/ui/prompt-unanswered-error';

/**
 * Issue #736: `onedrive save`, `sharepoint save` and `teams save` replaced an existing `--output`
 * file without asking. Each now asks first, skips the question with `-y`, and runs no save work
 * after a declined or unanswered question.
 */
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

interface SaveCase {
  name: string;
  register: (program: Command, get_container: () => Container) => void;
  token: symbol;
  argv: (output: string, extra: string[]) => string[];
  result: Record<string, unknown>;
}

const SAVE_CASES: SaveCase[] = [
  {
    name: 'onedrive save',
    register: register_onedrive_command,
    token: ONEDRIVE_SAVE_USE_CASE_TOKEN,
    argv: (output, extra) => [
      'onedrive',
      'save',
      '-o',
      'owner-1',
      '-s',
      'snap-1',
      '--output',
      output,
      ...extra,
    ],
    result: {
      snapshot_id: 'snap-1',
      files_saved: 0,
      files_skipped: [],
      unreadable_keys: [],
      unmatched_file_filters: [],
      integrity_failures: [],
      errors: [],
      total_bytes: 0,
      output_path: 'out.zip',
    },
  },
  {
    name: 'sharepoint save',
    register: register_sharepoint_command,
    token: SHAREPOINT_SAVE_USE_CASE_TOKEN,
    argv: (output, extra) => [
      'sharepoint',
      'save',
      '--site',
      SITE_ID,
      '-s',
      'snap-1',
      '--output',
      output,
      ...extra,
    ],
    result: {
      snapshot_id: 'snap-1',
      files_saved: 0,
      files_skipped: [],
      unreadable_keys: [],
      unmatched_file_filters: [],
      integrity_failures: [],
      errors: [],
      total_bytes: 0,
      output_path: 'out.zip',
    },
  },
  {
    name: 'teams save',
    register: register_teams_command,
    token: TEAMS_SAVE_USE_CASE_TOKEN,
    argv: (output, extra) => [
      'teams',
      'save',
      '--team',
      'team-1',
      '-s',
      'snap-1',
      '--output',
      output,
      ...extra,
    ],
    result: {
      snapshot_id: 'snap-1',
      channels_saved: 0,
      messages_saved: 0,
      images_inlined: 0,
      errors: [],
      interrupted: false,
      total_bytes: 0,
      output_path: 'out.zip',
    },
  },
];

describe.each(SAVE_CASES)('$name overwrite question (issue #736)', (save_case) => {
  let work_dir: string;
  let existing_output: string;
  let missing_output: string;
  let save_snapshot: Mock;
  let program: Command;
  let restore_stdin: () => void = () => {};

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    work_dir = mkdtempSync(join(tmpdir(), 'atlas-736-'));
    existing_output = join(work_dir, 'out.zip');
    missing_output = join(work_dir, 'new.zip');
    writeFileSync(existing_output, 'previous archive');

    save_snapshot = vi.fn().mockResolvedValue(save_case.result);
    const container = new Container();
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(save_case.token).toConstantValue({ save_snapshot });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
    program = new Command();
    save_case.register(program, () => container);
  });

  afterEach(() => {
    restore_stdin();
    rmSync(work_dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const run = (extra: string[] = [], output = existing_output): Promise<unknown> =>
    program.parseAsync(save_case.argv(output, extra), { from: 'user' });

  it('declines without saving or touching the existing file', async () => {
    restore_stdin = pipe_stdin('n\n');
    await run();

    expect(save_snapshot).not.toHaveBeenCalled();
    expect(readFileSync(existing_output, 'utf8')).toBe('previous archive');
    expect(process.exitCode).toBeUndefined();
  });

  it('replaces the existing file after a "y" answer', async () => {
    restore_stdin = pipe_stdin('y\n');
    await run();

    expect(save_snapshot).toHaveBeenCalledTimes(1);
  });

  it('fails with stdin at EOF without saving or touching the existing file', async () => {
    restore_stdin = pipe_stdin('');
    await expect(run()).rejects.toBeInstanceOf(PromptUnansweredError);

    expect(save_snapshot).not.toHaveBeenCalled();
    expect(readFileSync(existing_output, 'utf8')).toBe('previous archive');
  });

  it('skips the question with -y, even with stdin at EOF', async () => {
    restore_stdin = pipe_stdin('');
    await run(['-y']);

    expect(save_snapshot).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when the output path does not exist yet', async () => {
    restore_stdin = pipe_stdin('');
    await run([], missing_output);

    expect(save_snapshot).toHaveBeenCalledTimes(1);
  });
});
