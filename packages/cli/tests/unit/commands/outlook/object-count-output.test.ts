import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { Command } from 'commander';
import { register_outlook_command } from '@/commands/outlook/outlook.command';
import { render_static_view } from '@/ui/render';
import {
  BACKUP_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';

/**
 * Issue #711. `outlook backup` and `outlook list -m` printed the manifest's `total_objects`, a
 * high-water mark of single runs, so the figure disagreed with what `verify`, `restore` and `save`
 * read. Both now print the snapshot's merged chain count.
 */
const mock_run_backup_with_cli_adapter = vi.fn();

vi.mock('@/adapters/backup-operation.adapter', () => ({
  OUTLOOK_INTERRUPT_MESSAGE: 'stopping',
  run_backup_with_cli_adapter: (...args: unknown[]): unknown =>
    mock_run_backup_with_cli_adapter(...args),
}));
vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const MAILBOX = 'john.doe@example.com';

function snapshot_row(snapshot_id: string, object_count: number): Record<string, unknown> {
  return {
    snapshot_id,
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    manifest_key: `manifests/owner/${snapshot_id}.json`,
    entry_count: 3,
    total_size_bytes: 3,
    owner_id: 'owner',
    total_objects: 343,
    removed_count: 0,
    object_count,
  };
}

/** The rows of every DataTable the command rendered. */
function rendered_rows(): Array<Record<string, unknown>> {
  return vi
    .mocked(render_static_view)
    .mock.calls.map((call) => call[0] as { props?: { rows?: Array<Record<string, unknown>> } })
    .flatMap((element) => element.props?.rows ?? []);
}

describe('outlook object counts (issue #711)', () => {
  let program: Command;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(render_static_view).mockClear();
    const container = new Container();
    container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox: vi.fn() });
    container.bind(CATALOG_USE_CASE_TOKEN).toConstantValue({
      list_snapshot_summaries: vi
        .fn()
        .mockResolvedValue([snapshot_row('snap-2', 621), snapshot_row('snap-1', 566)]),
    });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi
        .fn()
        .mockResolvedValue({ object_id: 'owner', email: MAILBOX, display_name: 'John Doe' }),
    });
    program = new Command();
    register_outlook_command(program, () => container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the snapshot count after a backup, not the high-water mark', async () => {
    const success = vi.spyOn(logger, 'success');
    mock_run_backup_with_cli_adapter.mockResolvedValue({
      snapshot: { id: 'snap-2', object_count: 621 },
      manifest: { total_objects: 343, total_size_bytes: 2048 },
      summary: { folder_errors: [], warnings: [], excluded_folders: [], interrupted: false },
    });

    await program.parseAsync(['outlook', 'backup', '-m', MAILBOX], { from: 'user' });

    expect(success).toHaveBeenCalledWith(
      'Snapshot snap-2 -- 621 objects (2.0 KB captured by this run)',
    );
  });

  it('lists each snapshot with the count of its chain', async () => {
    await program.parseAsync(['outlook', 'list', '-m', MAILBOX], { from: 'user' });

    expect(rendered_rows().map((row) => [row.snapshot, row.objects])).toEqual([
      ['snap-2', '621'],
      ['snap-1', '566'],
    ]);
  });
});
