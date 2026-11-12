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
import {
  OwnerBusyError,
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { build_empty_result } from '@/services/backup/backup-builders';
import { interrupted_before_scan } from '@/services/backup/interrupted-scan-result';

@injectable()
export class SharePointSiteTreeBackupService implements SharePointSiteTreeBackupUseCase {
  constructor(
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_BACKUP_USE_CASE_TOKEN) private readonly _backup: SharePointBackupUseCase,
  ) {}

  /**
   * Backs up the site, then its subsites when asked; cancelling also ends the subsite listing.
   *
   * Each site is backed up under its own lease. A busy root site rejects with `OwnerBusyError`,
   * as a single-site backup does. A busy subsite is that subsite's failure: its result carries
   * the error and the remaining subsites are still backed up (issue #623).
   */
  async backup_site_tree(
    tenant_id: string,
    root_site_id: string,
    options: SharePointBackupOptions = {},
  ): Promise<SharePointBackupResult[]> {
    return run_cancellable(
      options,
      () => this.run_site_tree(tenant_id, root_site_id, options),
      () => [interrupted_before_scan(normalize_owner_id(root_site_id), options)],
    );
  }

  private async run_site_tree(
    tenant_id: string,
    root_site_id: string,
    options: SharePointBackupOptions,
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
      const subsite_result = await this.backup_subsite_unless_busy(tenant_id, subsite, options);
      results.push(subsite_result);
      if (subsite_result.interrupted) break;
    }

    return results;
  }

  /** Backs up one subsite; a subsite another operation holds becomes a failed, unhealthy result. */
  private async backup_subsite_unless_busy(
    tenant_id: string,
    subsite: SharePointSite,
    options: SharePointBackupOptions,
  ): Promise<SharePointBackupResult> {
    try {
      return await this._backup.backup_site(tenant_id, subsite.site_id, {
        ...options,
        site_url: subsite.site_url,
        site_display_name: subsite.display_name,
      });
    } catch (err) {
      if (!(err instanceof OwnerBusyError)) throw err;
      logger.warn(
        `Subsite ${subsite.site_url || subsite.site_id} was not backed up: ${err.message}`,
      );
      return busy_subsite_result(normalize_owner_id(subsite.site_id), err);
    }
  }
}

/** The result of a subsite that was not backed up because another operation held it. */
function busy_subsite_result(site_id: string, busy: OwnerBusyError): SharePointBackupResult {
  return build_empty_result(site_id, 0, 0, 0, 0, 0, 0, [busy.message], [], false, false, false);
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
