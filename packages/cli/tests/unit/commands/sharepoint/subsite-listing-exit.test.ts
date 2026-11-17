import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import {
  AuthError,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { handle_fatal_error } from '@/fatal-error';
import { execute_sharepoint_backup } from '@/commands/sharepoint/command.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const LISTING_FAILURE = 'Could not list subsites of parent-1: Access denied (403).';

/** One site's backup result, unhealthy only when a finding is passed. */
function site_result(site_id: string, findings: { errors?: string[]; interrupted?: boolean } = {}) {
  const errors = findings.errors ?? [];
  const interrupted = findings.interrupted === true;
  return {
    site_id,
    snapshot: undefined,
    interrupted,
    summary: {
      libraries_scanned: interrupted ? 0 : 1,
      files_changed: 0,
      files_stored: 0,
      files_deduplicated: 0,
      deleted_items: 0,
      cursor_updated: false,
      snapshot_created: false,
      versions_stored: 0,
      versions_unavailable: 0,
      errors,
      warnings: [],
      healthy: errors.length === 0 && !interrupted,
    },
  };
}

function bind_run(container: Container, results: ReturnType<typeof site_result>[] | Error) {
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({
    resolve_site: vi.fn().mockResolvedValue({
      site_id: 'site-1',
      display_name: 'Site',
      site_url: 'https://example.invalid/sites/site',
    }),
  });
  container.bind(SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN).toConstantValue({
    backup_site_tree:
      results instanceof Error
        ? vi.fn().mockRejectedValue(results)
        : vi.fn().mockResolvedValue(results),
  });
  return execute_sharepoint_backup(container, {
    tenant: TENANT,
    site: 'site-1',
    includeSubsites: true,
  });
}

describe('SharePoint backup exit code for the subsite listing', () => {
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

  it('reports UNHEALTHY and exits partial when a subsite listing failed, naming the error', async () => {
    await bind_run(new Container(), [site_result('site-1', { errors: [LISTING_FAILURE] })]);

    expect(logger.success).not.toHaveBeenCalledWith('Status: HEALTHY');
    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(logger.error).toHaveBeenCalledWith(`  file error: ${LISTING_FAILURE}`);
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('reports UNHEALTHY and exits partial when Ctrl+C lands between two sites', async () => {
    await bind_run(new Container(), [
      site_result('site-1'),
      site_result('site-2', { interrupted: true }),
    ]);

    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(logger.warn).toHaveBeenCalledWith('Run interrupted before all items were processed');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });

  it('exits with the auth code when the listing is refused', async () => {
    const run = bind_run(new Container(), new AuthError('token rejected'));

    await expect(run).rejects.toBeInstanceOf(AuthError);
    handle_fatal_error(await run.catch((err: unknown) => err));

    expect(logger.error).toHaveBeenCalledWith('  Atlas code: ATLAS_AUTH_DENIED');
    expect(process.exitCode).toBe(4);
  });

  it('leaves a run with every site healthy at exit 0', async () => {
    await bind_run(new Container(), [site_result('site-1'), site_result('site-2')]);

    expect(logger.success).toHaveBeenCalledWith('Status: HEALTHY');
    expect(process.exitCode).toBeUndefined();
  });
});
