import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import {
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';

/**
 * Issue #712: a drive `save` that skipped a damaged file printed `Files skipped: N -- exit 2`, then
 * set exit 1 because the same file was also in `errors`. The code it prints is now the code it
 * returns.
 */
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

interface SaveCase {
  name: string;
  register: (program: Command, get_container: () => Container) => void;
  token: symbol;
  argv: (output: string) => string[];
}

const SAVE_CASES: SaveCase[] = [
  {
    name: 'onedrive save',
    register: register_onedrive_command,
    token: ONEDRIVE_SAVE_USE_CASE_TOKEN,
    argv: (output) => ['onedrive', 'save', '-o', 'owner-1', '-s', 'snap-1', '--output', output],
  },
  {
    name: 'sharepoint save',
    register: register_sharepoint_command,
    token: SHAREPOINT_SAVE_USE_CASE_TOKEN,
    argv: (output) => ['sharepoint', 'save', '--site', SITE_ID, '-s', 'snap-1', '--output', output],
  },
];

/** A save result with one damaged file among three. */
function damaged_file_result(output_path: string): Record<string, unknown> {
  return {
    snapshot_id: 'snap-1',
    files_saved: 2,
    files_skipped: 1,
    unreadable_keys: [],
    unmatched_file_filters: [],
    integrity_failures: ['file-2'],
    errors: ['file-2.txt: Unsupported state or unable to authenticate data'],
    total_bytes: 0,
    output_path,
  };
}

describe.each(SAVE_CASES)('$name with a damaged file (issue #712)', (save_case) => {
  let work_dir: string;
  let error_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    error_spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    work_dir = mkdtempSync(join(tmpdir(), 'atlas-712-'));
  });

  afterEach(() => {
    rmSync(work_dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('exits 2, the code its skip line prints', async () => {
    const output = join(work_dir, 'out.zip');
    const container = new Container();
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container
      .bind(save_case.token)
      .toConstantValue({ save_snapshot: vi.fn().mockResolvedValue(damaged_file_result(output)) });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
    const program = new Command();
    save_case.register(program, () => container);

    await program.parseAsync(save_case.argv(output), { from: 'user' });

    const lines = error_spy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toContain('Files skipped: 1 -- exit 2');
    expect(process.exitCode).toBe(2);
  });
});
