import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import {
  AuthError,
  GraphUnavailableError,
  ONEDRIVE_STATUS_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_STATUS_USE_CASE_TOKEN,
  ThrottledError,
  USER_IDENTITY_RESOLVER_TOKEN,
  type OneDriveDriveStatus,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { describe_peek_error } from '@wisecom/atlas-core/services/shared/status-peek-error';
import { register_onedrive_command } from '@/commands/onedrive/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint/sharepoint.command';
import { handle_fatal_error } from '@/fatal-error';

const OWNER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SITE_ID = `contoso.sharepoint.com,${OWNER_ID},11111111-1111-1111-1111-111111111111`;
const THROTTLED = describe_peek_error(new ThrottledError('retry budget exhausted'));
const UNAVAILABLE = describe_peek_error(
  new GraphUnavailableError('Graph kept answering 503', { retries: 12, elapsed_ms: 60_000 }),
);
const REFUSED = 'GraphAccessRefusedError: Graph refused the drive';

function drive(name: string, overrides: Partial<OneDriveDriveStatus> = {}): OneDriveDriveStatus {
  return {
    drive_id: `id-${name}`,
    drive_name: name,
    has_backup: true,
    pending_changes: 0,
    failed_items: 0,
    is_up_to_date: true,
    ...overrides,
  };
}

function failed(name: string, peek_error: string): OneDriveDriveStatus {
  return drive(name, { is_up_to_date: false, peek_error });
}

function totals(rows: OneDriveDriveStatus[]): Record<string, unknown> {
  return {
    last_backup_at: new Date('2026-08-01T10:00:00Z'),
    last_snapshot_id: 'snap-1',
    is_up_to_date: rows.every((row) => row.is_up_to_date),
    total_pending_changes: rows.reduce((sum, row) => sum + row.pending_changes, 0),
    total_failed_items: 0,
  };
}

interface Workload {
  readonly name: string;
  readonly argv: readonly string[];
  readonly mock_result: (check: Mock, rows: OneDriveDriveStatus[]) => void;
}

const WORKLOADS: readonly Workload[] = [
  {
    name: 'onedrive status',
    argv: ['onedrive', 'status', '-o', OWNER_ID],
    mock_result: (check, rows) =>
      check.mockResolvedValue({
        owner_id: OWNER_ID,
        total_drives: rows.length,
        drives: rows,
        ...totals(rows),
      }),
  },
  {
    name: 'sharepoint status',
    argv: ['sharepoint', 'status', '--site', SITE_ID],
    mock_result: (check, rows) =>
      check.mockResolvedValue({
        site_id: SITE_ID,
        total_libraries: rows.length,
        libraries: rows,
        ...totals(rows),
      }),
  },
];

/** Issue #870: drive status commands exit non-zero when a drive or library could not be checked. */
describe.each(WORKLOADS)('$name exit code', (workload) => {
  let previous: typeof process.exitCode;
  let check: Mock;
  let program: Command;

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    check = vi.fn();
    const container = new Container();
    container
      .bind(ONEDRIVE_STATUS_USE_CASE_TOKEN)
      .toConstantValue({ check_onedrive_status: check });
    container
      .bind(SHAREPOINT_STATUS_USE_CASE_TOKEN)
      .toConstantValue({ check_sharepoint_status: check });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
    container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site: vi.fn() });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });
    program = new Command();
    program.exitOverride();
    register_onedrive_command(program, () => container);
    register_sharepoint_command(program, () => container);
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  async function run_status(): Promise<void> {
    await program.parseAsync([...workload.argv], { from: 'user' });
  }

  it('exits 3 when every drive failed on a throttle or an unavailable Graph', async () => {
    workload.mock_result(check, [failed('Documents', THROTTLED), failed('Archive', UNAVAILABLE)]);

    await run_status();

    expect(process.exitCode).toBe(3);
  });

  it('exits 2 when every drive failed and one failure was not transient', async () => {
    workload.mock_result(check, [failed('Documents', THROTTLED), failed('Archive', REFUSED)]);

    await run_status();

    expect(process.exitCode).toBe(2);
  });

  it('exits 2 when one drive was checked and another failed', async () => {
    workload.mock_result(check, [drive('Documents'), failed('Archive', REFUSED)]);

    await run_status();

    expect(process.exitCode).toBe(2);
  });

  it('exits 3 when one drive was checked and the other was throttled', async () => {
    workload.mock_result(check, [drive('Documents'), failed('Archive', THROTTLED)]);

    await run_status();

    expect(process.exitCode).toBe(3);
  });

  it('exits as before when every peek succeeded, pending changes or not', async () => {
    workload.mock_result(check, [
      drive('Documents'),
      drive('Archive', { pending_changes: 4, is_up_to_date: false }),
    ]);

    await run_status();

    expect(process.exitCode).toBeUndefined();
  });

  it('still exits 4 on an auth failure', async () => {
    check.mockRejectedValue(new AuthError('Graph returned 401'));

    await run_status().catch(handle_fatal_error);

    expect(process.exitCode).toBe(4);
  });
});
