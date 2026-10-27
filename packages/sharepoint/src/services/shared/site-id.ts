/**
 * Drops the hostname from Graph's composite site id (`hostname,siteGuid,webGuid`).
 *
 * The site id keys every SharePoint storage prefix, and the hostname is the one part that
 * changes when a tenant renames its SharePoint domain, which would otherwise start a second
 * backup history for every site. Graph accepts `siteGuid,webGuid` wherever it takes a site id.
 * Pure string work, so `rehydrate` still resolves a site with Graph unreachable. Ids that are
 * already canonical pass through unchanged.
 */
export function canonical_site_id(site_id: string): string {
  const parts = site_id.split(',');
  return parts.length === 3 ? `${parts[1]},${parts[2]}` : site_id;
}
