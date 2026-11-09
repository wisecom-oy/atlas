import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { execute_onedrive_backup } from '@/commands/onedrive/command.handlers';
import { execute_sharepoint_backup } from '@/commands/sharepoint/command.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';

/**
 * A run whose only problem is a file still in the failed-item ledger: the service reports it as a
 * warning and holds `healthy` false, with no error entry (#583).
 */
function summary(healthy: boolean) {
  return {
    files_changed: 0,
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    cursor_updated: true,
    snapshot_created: false,
    versions_stored: 0,
    versions_unavailable: 0,
    errors: [],
    warnings: healthy ? [] : ['file-1: download failed (attempt 1/5)'],
    healthy,
  };
}

const workloads = [
  {
    name: 'OneDrive',
    run: (container: Container, healthy: boolean) => {
      // An owner id without `@` never reaches Graph, but the handler resolves the resolver first.
      container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
      container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).toConstantValue({
        backup_onedrive: vi.fn().mockResolvedValue({
          owner_id: 'owner-1',
          snapshot: undefined,
          interrupted: false,
          summary: { drives_scanned: 1, ...summary(healthy) },
        }),
      });
      return execute_onedrive_backup(container, { tenant: TENANT, owner: 'owner-1' });
    },
  },
  {
    name: 'SharePoint',
    run: (container: Container, healthy: boolean) => {
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
            snapshot: undefined,
            interrupted: false,
            summary: { libraries_scanned: 1, ...summary(healthy) },
          },
        ]),
      });
      return execute_sharepoint_backup(container, { tenant: TENANT, site: 'site-1' });
    },
  },
];

describe.each(workloads)('$name backup exit code', ({ run }) => {
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

  it('exits partial when only the failed-item ledger leaves the run unhealthy', async () => {
    await run(new Container(), false);

    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('leaves a healthy run at exit 0', async () => {
    await run(new Container(), true);

    expect(logger.success).toHaveBeenCalledWith('Status: HEALTHY');
    expect(process.exitCode).toBeUndefined();
  });
});
