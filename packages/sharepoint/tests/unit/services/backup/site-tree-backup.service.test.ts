import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type {
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSite,
  SharePointSiteConnector,
} from '@wisecom/atlas-types';
import { SharePointSiteTreeBackupService } from '@/services/backup/site-tree-backup.service';

function site(id: string): SharePointSite {
  return { site_id: id, site_url: `https://contoso.sharepoint.com/sites/${id}`, display_name: id };
}

function make_result(site_id: string, interrupted = false): SharePointBackupResult {
  return {
    site_id,
    snapshot: undefined,
    interrupted,
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

describe('SharePointSiteTreeBackupService', () => {
  let connector: SharePointSiteConnector;
  let backup: SharePointBackupUseCase;
  let service: SharePointSiteTreeBackupService;

  beforeEach(() => {
    connector = {
      list_subsites: vi.fn().mockResolvedValue({ sites: [], warnings: [] }),
    } as unknown as SharePointSiteConnector;
    backup = {
      backup_site: vi.fn(async (_t: string, site_id: string) => make_result(site_id)),
    } as unknown as SharePointBackupUseCase;
    service = new SharePointSiteTreeBackupService(connector, backup);
  });

  it('backs up only the root when the site has no subsites', async () => {
    const results = await service.backup_site_tree('t', 'root');

    expect(results.map((r) => r.site_id)).toEqual(['root']);
    expect(results[0]!.summary.warnings).toEqual([]);
  });

  it('warns per uncovered subsite instead of silently skipping them', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx'), site('projecty')],
      warnings: [],
    });

    const results = await service.backup_site_tree('t', 'root');

    expect(results).toHaveLength(1);
    expect(backup.backup_site).toHaveBeenCalledTimes(1);
    const warnings = results[0]!.summary.warnings;
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('projectx');
    expect(warnings[0]).toContain('--include-subsites');
  });

  it('backs up every subsite when include_subsites is set', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx'), site('projectx-sub')],
      warnings: [],
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results.map((r) => r.site_id)).toEqual(['root', 'projectx', 'projectx-sub']);
    expect(results[0]!.summary.warnings).toEqual([]);
  });

  it('passes each subsite its own url and display name', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx')],
      warnings: [],
    });

    await service.backup_site_tree('t', 'root', { include_subsites: true, force_full: true });

    expect(backup.backup_site).toHaveBeenLastCalledWith(
      't',
      'projectx',
      expect.objectContaining({
        force_full: true,
        site_url: 'https://contoso.sharepoint.com/sites/projectx',
        site_display_name: 'projectx',
      }),
    );
  });

  it('surfaces enumeration warnings even when subsites are included', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [],
      warnings: ['Could not enumerate subsites of https://contoso.sharepoint.com/sites/locked'],
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results[0]!.summary.warnings.join(' ')).toContain('locked');
  });
  it('does not start another subsite after an interrupted result', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx'), site('projecty')],
      warnings: [],
    });
    vi.mocked(backup.backup_site).mockImplementation(async (_tenant, site_id) => {
      return make_result(site_id, site_id === 'projectx');
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results.map((result) => result.site_id)).toEqual(['root', 'projectx']);
    expect(backup.backup_site).toHaveBeenCalledTimes(2);
  });
});
