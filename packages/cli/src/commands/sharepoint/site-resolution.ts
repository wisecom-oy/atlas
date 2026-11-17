import type { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { canonical_site_id } from '@wisecom/atlas-sharepoint';
import { SHAREPOINT_CONNECTOR_TOKEN, type SharePointSiteConnector } from '@wisecom/atlas-types';

/**
 * Resolves a `--site` input to the hostname-free site id (`siteGuid,webGuid`) used in storage keys.
 * A composite id is reduced by string work alone, so disaster recovery keeps working when Graph is
 * unreachable. Anything else, a browser URL or `hostname:/sites/<name>`, goes through Graph like
 * every other SharePoint command (issue #90).
 */
export async function resolve_site_id(
  container: Container,
  tenant_id: string,
  site_input: string,
): Promise<string> {
  if (site_input.includes(',')) return canonical_site_id(site_input);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, site_input);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);
  return site.site_id;
}
