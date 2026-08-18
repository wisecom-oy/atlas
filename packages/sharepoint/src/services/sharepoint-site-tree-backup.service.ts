/**
 * Backs up a SharePoint site together with its subsite tree.
 *
 * A subsite is a Graph site in its own right, with its own drives, so it needs
 * its own snapshot rather than being folded into the parent's manifest. This
 * service is therefore a fan-out over the ordinary per-site backup pipeline,
 * which keeps subsite snapshots structurally identical to root-site snapshots
 * and leaves restore addressing unambiguous.
 *
 * Subsites are always enumerated, even when they will not be backed up: a site
 * whose subsites are silently out of scope is the failure mode this exists to
 * prevent, so the uncovered ones are reported as warnings on the root result.
 */

import { inject, injectable } from 'inversify';
import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSite,
  SharePointSiteTreeBackupUseCase,
  SharePointSiteConnector,
} from '@wisecom/atlas-types';
import { SHAREPOINT_BACKUP_USE_CASE_TOKEN, SHAREPOINT_CONNECTOR_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

@injectable()
export class SharePointSiteTreeBackupService implements SharePointSiteTreeBackupUseCase {
  constructor(
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_BACKUP_USE_CASE_TOKEN) private readonly _backup: SharePointBackupUseCase,
  ) {}

  async backup_site_tree(
    tenant_id: string,
    root_site_id: string,
    options: SharePointBackupOptions = {},
  ): Promise<SharePointBackupResult[]> {
    const tree = await this._connector.list_subsites(tenant_id, root_site_id);
    const include_subsites = options.include_subsites === true;

    const root_warnings = [
      ...tree.warnings,
      ...(include_subsites ? [] : uncovered_subsite_warnings(tree.sites)),
    ];

    const root_result = await this._backup.backup_site(tenant_id, root_site_id, options);
    const results = [with_extra_warnings(root_result, root_warnings)];

    if (!include_subsites || root_result.interrupted) return results;

    for (const subsite of tree.sites) {
      if (options.should_interrupt?.() === true) break;
      logger.info(`Backing up subsite: ${subsite.display_name || subsite.site_url}`);
      const subsite_result = await this._backup.backup_site(tenant_id, subsite.site_id, {
        ...options,
        site_url: subsite.site_url,
        site_display_name: subsite.display_name,
      });
      results.push(subsite_result);
      if (subsite_result.interrupted) break;
    }

    return results;
  }
}

/** One warning per subsite left out of the backup, naming the flag that covers it. */
function uncovered_subsite_warnings(subsites: SharePointSite[]): string[] {
  return subsites.map(
    (s) =>
      `Subsite not backed up: ${s.site_url || s.site_id}` +
      `${s.display_name ? ` (${s.display_name})` : ''}. ` +
      'Re-run with --include-subsites, or back it up individually.',
  );
}

/** Returns the result with additional warnings merged into its summary. */
function with_extra_warnings(
  result: SharePointBackupResult,
  extra: string[],
): SharePointBackupResult {
  if (extra.length === 0) return result;
  return {
    ...result,
    summary: { ...result.summary, warnings: [...result.summary.warnings, ...extra] },
  };
}
