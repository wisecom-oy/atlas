import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import {
  AuthError,
  type SharePointBackupResult,
  type SharePointBackupUseCase,
  type SharePointSite,
  type SharePointSiteConnector,
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
      list_subsites: vi.fn().mockResolvedValue({ sites: [], warnings: [], errors: [] }),
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
      errors: [],
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
      errors: [],
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results.map((r) => r.site_id)).toEqual(['root', 'projectx', 'projectx-sub']);
    expect(results[0]!.summary.warnings).toEqual([]);
  });

  it('passes each subsite its own url and display name', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx')],
      warnings: [],
      errors: [],
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
      warnings: ['Subsite nesting exceeded 20 levels; deeper subsites are NOT covered.'],
      errors: [],
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results[0]!.summary.warnings.join(' ')).toContain('exceeded 20 levels');
    expect(results[0]!.summary.healthy).toBe(true);
  });

  it('makes the root result unhealthy when a subsite listing failed with --include-subsites', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [],
      warnings: [],
      errors: ['Could not list subsites of parent-1: Access denied (403).'],
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results[0]!.summary.healthy).toBe(false);
    expect(results[0]!.summary.errors).toEqual([
      'Could not list subsites of parent-1: Access denied (403).',
    ]);
    expect(results[0]!.summary.warnings).toEqual([]);
  });

  it('keeps a listing failure a warning when subsites are not included', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [],
      warnings: [],
      errors: ['Could not list subsites of parent-1: Access denied (403).'],
    });

    const results = await service.backup_site_tree('t', 'root');

    expect(results[0]!.summary.healthy).toBe(true);
    expect(results[0]!.summary.errors).toEqual([]);
    expect(results[0]!.summary.warnings.join(' ')).toContain('parent-1');
  });

  it('rejects the whole run with the AuthError when the listing is refused', async () => {
    vi.mocked(connector.list_subsites).mockRejectedValue(new AuthError('token rejected'));

    await expect(
      service.backup_site_tree('t', 'root', { include_subsites: true }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(backup.backup_site).not.toHaveBeenCalled();
  });

  it('returns an interrupted result when cancelled inside the subsite listing', async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled');
    vi.mocked(connector.list_subsites).mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });

    const results = await service.backup_site_tree('t', 'root', {
      include_subsites: true,
      abort_signal: controller.signal,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.interrupted).toBe(true);
    expect(results[0]!.summary.healthy).toBe(false);
    expect(backup.backup_site).not.toHaveBeenCalled();
  });

  it('does not start another subsite after an interrupted result', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx'), site('projecty')],
      warnings: [],
      errors: [],
    });
    vi.mocked(backup.backup_site).mockImplementation(async (_tenant, site_id) => {
      return make_result(site_id, site_id === 'projectx');
    });

    const results = await service.backup_site_tree('t', 'root', { include_subsites: true });

    expect(results.map((result) => result.site_id)).toEqual(['root', 'projectx']);
    expect(backup.backup_site).toHaveBeenCalledTimes(2);
  });

  it('ends with an interrupted result when Ctrl+C lands between two subsites', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx'), site('projecty')],
      warnings: [],
      errors: [],
    });
    let interrupted = false;
    vi.mocked(backup.backup_site).mockImplementation(async (_tenant, site_id) => {
      if (site_id === 'projectx') interrupted = true;
      return make_result(site_id);
    });

    const results = await service.backup_site_tree('t', 'root', {
      include_subsites: true,
      should_interrupt: () => interrupted,
    });

    expect(results.map((result) => result.site_id)).toEqual(['root', 'projectx', 'projecty']);
    expect(results[1]!.interrupted).toBe(false);
    expect(results[2]!.interrupted).toBe(true);
    expect(results[2]!.summary.healthy).toBe(false);
    expect(backup.backup_site).toHaveBeenCalledTimes(2);
  });

  it('does not invent an interrupted result when the interrupt lands after the last subsite', async () => {
    vi.mocked(connector.list_subsites).mockResolvedValue({
      sites: [site('projectx')],
      warnings: [],
      errors: [],
    });
    let interrupted = false;
    vi.mocked(backup.backup_site).mockImplementation(async (_tenant, site_id) => {
      if (site_id === 'projectx') interrupted = true;
      return make_result(site_id);
    });

    const results = await service.backup_site_tree('t', 'root', {
      include_subsites: true,
      should_interrupt: () => interrupted,
    });

    expect(results.map((result) => result.interrupted)).toEqual([false, false]);
  });
});
