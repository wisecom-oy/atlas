import { classify_site_kind } from '@wisecom/atlas-sharepoint';

/**
 * True when a SharePoint site's web URL is a SharePoint Embedded container's (path under
 * `/contentstorage/`). Atlas cannot back these up, and `sharepoint.listSites()` marks them with
 * `kind: 'file_storage_container'` by the same rule, so a caller with its own site discovery can
 * filter them the way Atlas does (issue #772).
 */
export function isFileStorageContainerSite(web_url: string): boolean {
  return classify_site_kind(web_url) === 'file_storage_container';
}
