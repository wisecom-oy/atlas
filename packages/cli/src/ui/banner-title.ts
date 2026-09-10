/**
 * The one place a command banner title is built.
 *
 * Titles used to be written by hand at each render site, which produced `Atlas Backup` next to
 * `Atlas OneDrive Backup` and `Replication Status` with no product name at all (issue #162). A
 * workload-scoped command names its workload; a tenant-scoped one does not.
 */

/** Which surface a command acts on: a workload, or the tenant as a whole. */
export type BannerScope = 'outlook' | 'onedrive' | 'sharepoint' | 'tenant';

const SCOPE_LABELS: Record<BannerScope, string> = {
  outlook: 'Outlook',
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
  tenant: '',
};

/** Builds a banner title: `Atlas · OneDrive Backup`, or `Atlas · Replicate` for tenant scope. */
export function banner_title(scope: BannerScope, verb: string): string {
  const label = SCOPE_LABELS[scope];
  return label === '' ? `Atlas · ${verb}` : `Atlas · ${label} ${verb}`;
}
