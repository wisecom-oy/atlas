import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { SharePointSite } from '@wisecom/atlas-types';
import type { GraphCollectionResponse } from '@/adapters/graph-sharepoint-delta-fetch';
import { SHAREPOINT_DOWNLOAD_EXECUTOR } from '@/adapters/graph-sharepoint-download-executor';
import { parse_site_reference } from '@/adapters/graph-sharepoint-url-parser';
import { has_site_id, map_site_record, type GraphSiteRecord } from '@/adapters/graph-site-record';
import { classify_site_kind } from '@/services/shared/site-kind';

const SITE_SEARCH_URL = '/sites?search=*&$select=id,webUrl,displayName&$top=100';

/**
 * Lists every site `/sites?search=*` returns, following continuation links. SharePoint Embedded
 * container sites are listed with `kind: 'file_storage_container'` rather than left out, so a
 * caller still sees them and can skip them (issue #772).
 */
export async function list_tenant_sites(client: Client): Promise<SharePointSite[]> {
  const sites: SharePointSite[] = [];
  let next_url: string | undefined = SITE_SEARCH_URL;
  while (next_url) {
    const url = next_url;
    // Retry wraps a single page, never the whole walk.
    const page: GraphCollectionResponse<GraphSiteRecord> = await with_graph_retry(
      () => client.api(url).get() as Promise<GraphCollectionResponse<GraphSiteRecord>>,
    );
    for (const raw of page.value ?? []) {
      if (has_site_id(raw)) sites.push(map_site_record(raw));
    }
    next_url = page['@odata.nextLink'];
  }
  return sites;
}

/**
 * Resolves one site by URL path (hostname:/path), full URL, or site ID. A 403 is classified the
 * way a library listing's is, so the CLI and the SDK name the same refusal for the same site.
 */
export async function resolve_site_reference(
  client: Client,
  site_url_or_id: string,
): Promise<SharePointSite> {
  const graph_ref = parse_site_reference(site_url_or_id);
  let raw: GraphSiteRecord;
  try {
    raw = await with_graph_retry(
      () =>
        client
          .api(`/sites/${graph_ref}?$select=id,webUrl,displayName`)
          .get() as Promise<GraphSiteRecord>,
    );
  } catch (err) {
    await SHAREPOINT_DOWNLOAD_EXECUTOR.rethrow_if_access_denied(client, err, {
      label: `site ${site_url_or_id}`,
      // A composite site ID contains commas; a URL or `hostname:/path` reference is not an ID.
      site_id: site_url_or_id.includes(',') ? site_url_or_id : undefined,
      is_file_storage_container: is_container_reference(site_url_or_id),
    });
    throw err;
  }
  if (!has_site_id(raw)) {
    throw new Error(`Failed to resolve SharePoint site: ${site_url_or_id}`);
  }
  return map_site_record(raw);
}

/**
 * True when a site reference given as a URL or as `hostname:/path` points at a SharePoint Embedded
 * container. A site ID carries no path, so it never does.
 */
function is_container_reference(site_url_or_id: string): boolean {
  const as_url = /^https?:\/\//i.test(site_url_or_id)
    ? site_url_or_id
    : site_url_or_id.includes(':/')
      ? `https://${site_url_or_id.replace(':/', '/')}`
      : undefined;
  return as_url !== undefined && classify_site_kind(as_url) === 'file_storage_container';
}
