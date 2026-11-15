import type { SharePointSiteKind } from '@wisecom/atlas-types';

/**
 * The first path segment of every SharePoint Embedded container site. Graph lists these sites in
 * `/sites?search=*` but answers 403 `accessDenied` to an app holding only `Sites` permissions,
 * which is indistinguishable by error code from a missing grant (issue #772).
 */
const FILE_STORAGE_CONTAINER_SEGMENT = 'contentstorage';

/**
 * Classifies a site by its web URL: `file_storage_container` when the path starts with
 * `/contentstorage/`, otherwise `site`. A value that is not a URL is an ordinary site.
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
