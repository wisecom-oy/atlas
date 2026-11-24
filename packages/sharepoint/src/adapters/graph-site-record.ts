import type { SharePointSite } from '@wisecom/atlas-types';
import { canonical_site_id } from '@wisecom/atlas-types/domain/sharepoint/site-id';
import { classify_site_kind } from '@wisecom/atlas-types/domain/sharepoint/site-kind';

/** The site fields Atlas selects from Graph (`$select=id,webUrl,displayName`). */
export interface GraphSiteRecord {
  id?: string;
  webUrl?: string;
  displayName?: string;
}

/** Maps a Graph site record that has an id to the port's site shape, with its `kind`. */
export function map_site_record(raw: GraphSiteRecord & { id: string }): SharePointSite {
  const site_url = raw.webUrl ?? '';
  return {
    site_id: canonical_site_id(raw.id),
    site_url,
    display_name: raw.displayName ?? '',
    kind: classify_site_kind(site_url),
  };
}

/** True for a Graph site record that carries an id. */
export function has_site_id(raw: GraphSiteRecord): raw is GraphSiteRecord & { id: string } {
  return typeof raw.id === 'string' && raw.id !== '';
}
