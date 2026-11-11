import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type NoSnapshotReason,
} from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { execute_onedrive_backup } from '@/commands/onedrive/command.handlers';
import { execute_sharepoint_backup } from '@/commands/sharepoint/command.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

/**
 * A drive or site backup that stored nothing must not claim the source is unchanged unless the
 * service says so: an interrupted or all-failed run carries no `no_snapshot_reason` (#683).
 */

const TENANT = 'tenant-example';
const NOT_STORED = 'No snapshot created: the run was interrupted or every change failed.';

interface RunShape {
  readonly interrupted: boolean;
  readonly healthy: boolean;
  readonly errors: string[];
  readonly no_snapshot_reason?: NoSnapshotReason;
  readonly snapshot_id?: string;
}

/** Builds the summary fields both providers share. */
function summary(shape: RunShape) {
  return {
    files_changed: shape.snapshot_id ? 1 : 0,
    files_stored: shape.snapshot_id ? 1 : 0,
    files_deduplicated: 0,
    deleted_items: 0,
    cursor_updated: true,
    snapshot_created: shape.snapshot_id !== undefined,
    ...(shape.no_snapshot_reason ? { no_snapshot_reason: shape.no_snapshot_reason } : {}),
    versions_stored: 0,
    versions_unavailable: 0,
    errors: shape.errors,
    warnings: [],
    healthy: shape.healthy,
  };
}

/** A snapshot stub carrying only what the handler prints. */
function snapshot(shape: RunShape) {
  return shape.snapshot_id ? { snapshot_id: shape.snapshot_id } : undefined;
}

const workloads = [
  {
    name: 'OneDrive',
    unchanged: 'No OneDrive changes detected. Snapshot skipped.',
    run: (container: Container, shape: RunShape) => {
      container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
      container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).toConstantValue({
        backup_onedrive: vi.fn().mockResolvedValue({
          owner_id: 'owner-1',
          snapshot: snapshot(shape),
          interrupted: shape.interrupted,
          summary: { drives_scanned: 1, ...summary(shape) },
        }),
      });
      return execute_onedrive_backup(container, { tenant: TENANT, owner: 'owner-1' });
    },
  },
  {
    name: 'SharePoint',
    unchanged: 'No SharePoint changes detected. Snapshot skipped.',
    run: (container: Container, shape: RunShape) => {
      container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({
        resolve_site: vi.fn().mockResolvedValue({
          site_id: 'site-1',
          display_name: 'Site',
          site_url: 'https://example.invalid/sites/site',
        }),
      });
      container.bind(SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN).toConstantValue({
        backup_site_tree: vi.fn().mockResolvedValue([
          {
            site_id: 'site-1',
            snapshot: snapshot(shape),
            interrupted: shape.interrupted,
            summary: { libraries_scanned: 1, ...summary(shape) },
          },
        ]),
      });
      return execute_sharepoint_backup(container, { tenant: TENANT, site: 'site-1' });
    },
  },
];

describe.each(workloads)('$name backup that created no snapshot', ({ run, unchanged }) => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('says nothing was stored when the run was interrupted before storing a file', async () => {
    await run(new Container(), { interrupted: true, healthy: false, errors: [] });

    expect(logger.info).not.toHaveBeenCalledWith(unchanged);
    expect(logger.warn).toHaveBeenCalledWith(NOT_STORED);
    expect(logger.warn).toHaveBeenCalledWith('Run interrupted before all items were processed');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('says nothing was stored when every changed file failed', async () => {
    await run(new Container(), {
      interrupted: false,
      healthy: false,
      errors: ['file-1: download failed'],
    });

    expect(logger.info).not.toHaveBeenCalledWith(unchanged);
    expect(logger.warn).toHaveBeenCalledWith(NOT_STORED);
    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('reports a healthy unchanged run as unchanged', async () => {
    await run(new Container(), {
      interrupted: false,
      healthy: true,
      errors: [],
      no_snapshot_reason: 'no_changes',
    });

    expect(logger.info).toHaveBeenCalledWith(unchanged);
    expect(logger.warn).not.toHaveBeenCalledWith(NOT_STORED);
    expect(process.exitCode).toBeUndefined();
  });

  it('still prints the snapshot id of a run interrupted after it stored one', async () => {
    await run(new Container(), {
      interrupted: true,
      healthy: false,
      errors: [],
      snapshot_id: 'snap-1',
    });

    expect(logger.success).toHaveBeenCalledWith('Snapshot snap-1 created');
    expect(logger.warn).not.toHaveBeenCalledWith(NOT_STORED);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });
});
