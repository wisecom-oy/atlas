/**
 * Issue #623: each site in a tree is backed up under its own lease. A subsite another operation
 * holds must be reported as that subsite's failure, not abort the subsites after it.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSite,
  SharePointSiteConnector,
} from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { SharePointSiteTreeBackupService } from '@/services/backup/site-tree-backup.service';

function site(id: string): SharePointSite {
  return { site_id: id, site_url: `https://contoso.sharepoint.com/sites/${id}`, display_name: id };
}

function healthy_result(site_id: string): SharePointBackupResult {
  return {
    site_id,
    snapshot: undefined,
    interrupted: false,
    summary: {
      libraries_scanned: 1,
      files_changed: 0,
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      cursor_updated: true,
      snapshot_created: false,
      versions_stored: 0,
      versions_unavailable: 0,
      errors: [],
      warnings: [],
      healthy: true,
    },
  };
}

function busy(site_id: string): OwnerBusyError {
  return new OwnerBusyError({
    workload: 'sharepoint',
    owner_id: site_id,
    held_by_operation: 'backup',
    lease_expires_at: '2026-03-01T10:05:00.000Z',
  });
}

/** A tree of root, projectx and projecty in which the named sites are held by another run. */
function tree_with_busy_sites(...busy_sites: string[]) {
  const connector = {
    list_subsites: vi.fn().mockResolvedValue({
      sites: [site('projectx'), site('projecty')],
      warnings: [],
    }),
  } as unknown as SharePointSiteConnector;
  const backup = {
    backup_site: vi.fn(async (_tenant: string, site_id: string) => {
      if (busy_sites.includes(site_id)) throw busy(site_id);
      return healthy_result(site_id);
    }),
  } as unknown as SharePointBackupUseCase;
  return { backup, service: new SharePointSiteTreeBackupService(connector, backup) };
}

describe('SharePoint site tree with a busy site (issue #623)', () => {
  it('reports a busy subsite as that subsite failure and still backs up the next one', async () => {
    const { backup, service } = tree_with_busy_sites('projectx');

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results.map((r) => r.site_id)).toEqual(['root', 'projectx', 'projecty']);
    expect(backup.backup_site).toHaveBeenCalledTimes(3);
    const refused = results[1]!;
    expect(refused.summary.healthy).toBe(false);
    expect(refused.summary.cursor_updated).toBe(false);
    expect(refused.interrupted).toBe(false);
    expect(refused.summary.errors).toEqual([
      expect.stringContaining('Another backup is running on sharepoint owner projectx'),
    ]);
    expect(results[0]!.summary.healthy).toBe(true);
    expect(results[2]!.summary.healthy).toBe(true);
  });

  it('rejects with the busy error when the root site itself is held, as a single-site run does', async () => {
    const { backup, service } = tree_with_busy_sites('root');

    await expect(
      service.backup_site_tree('t', 'root', { include_subsites: true }),
    ).rejects.toBeInstanceOf(OwnerBusyError);

    expect(backup.backup_site).toHaveBeenCalledTimes(1);
  });

  it('still fails the tree on a subsite error that is not a busy owner', async () => {
    const { backup, service } = tree_with_busy_sites();
    vi.mocked(backup.backup_site).mockImplementation(async (_tenant, site_id) => {
      if (site_id === 'projectx') throw new Error('storage unavailable');
      return healthy_result(site_id);
    });

    await expect(service.backup_site_tree('t', 'root', { include_subsites: true })).rejects.toThrow(
      'storage unavailable',
    );
  });
});
