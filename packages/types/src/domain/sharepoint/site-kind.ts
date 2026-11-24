import type { SharePointSiteKind } from '@/ports/sharepoint/connector.port';

/**
 * The first path segment of every SharePoint Embedded container site. Graph lists these sites in
 * `/sites?search=*` but answers 403 `accessDenied` to an app holding only `Sites` permissions,
 * which is indistinguishable by error code from a missing grant (issue #772).
 */
const FILE_STORAGE_CONTAINER_SEGMENT = 'contentstorage';

/**
 * Classifies a site by its web URL: `file_storage_container` when the first nonempty path segment
 * is `contentstorage` in any case, otherwise `site`. A value that is not a URL is an ordinary site.
 *
 * Imports only a type: the SDK publishes this rule through `@wisecom/atlas-sdk/contract`, so a
 * Worker running its own site discovery filters containers the way Atlas does (issue #831).
 */
export function classify_site_kind(web_url: string): SharePointSiteKind {
  let path: string;
  try {
    path = new URL(web_url).pathname;
  } catch {
    return 'site';
  }
  const first_segment = path.split('/').find((segment) => segment !== '');
  return first_segment?.toLowerCase() === FILE_STORAGE_CONTAINER_SEGMENT
    ? 'file_storage_container'
    : 'site';
}

/** True when a site's web URL is a SharePoint Embedded container's, which Atlas cannot back up. */
export function is_file_storage_container_site(web_url: string): boolean {
  return classify_site_kind(web_url) === 'file_storage_container';
}
