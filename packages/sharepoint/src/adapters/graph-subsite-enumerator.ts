/**
 * Recursive traversal of a SharePoint site's subsite tree.
 *
 * `GET /sites/{site-id}/sites` returns only the *direct* subsites of a site,
 * and only those the application has access to. Backing up a site therefore
 * has to walk the tree explicitly, and has to distinguish "no subsites" from
 * "subsites we were not allowed to see" -- an access error is reported as an
 * error instead of silently narrowing the backup scope.
 *
 * @see https://learn.microsoft.com/en-us/graph/api/site-list-subsites
 */

import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { AuthError, type SharePointSite, type SharePointSubsiteTree } from '@wisecom/atlas-types';
import { canonical_site_id } from '@/services/shared/site-id';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import { is_cancellation_of } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';

interface GraphSiteRecord {
  id?: string;
  webUrl?: string;
  displayName?: string;
}

interface GraphSiteCollection {
  value?: GraphSiteRecord[];
  '@odata.nextLink'?: string;
}

/** Pages through `GET /sites/{id}/sites`, the direct subsites of one site. */
export async function fetch_direct_subsites(
  client: Client,
  site_id: string,
): Promise<SharePointSite[]> {
  const sites: SharePointSite[] = [];
  let next_url: string | undefined = `/sites/${site_id}/sites?$select=id,webUrl,displayName`;

  while (next_url) {
    const url = next_url;
    const page: GraphSiteCollection = await with_graph_retry(
      () => client.api(url).get() as Promise<GraphSiteCollection>,
    );

    for (const raw of page.value ?? []) {
      if (!raw.id) continue;
      sites.push({
        site_id: canonical_site_id(raw.id),
        site_url: raw.webUrl ?? '',
        display_name: raw.displayName ?? '',
      });
    }

    next_url = page['@odata.nextLink'];
  }

  return sites;
}

/**
 * Depth ceiling for the walk. SharePoint site trees are shallow in practice;
 * this exists so a Graph anomaly cannot turn into an unbounded traversal.
 */
const MAX_SUBSITE_DEPTH = 20;

/** Fetches the direct subsites of one site. Rejects when the site is unreadable. */
export type DirectSubsiteFetcher = (site_id: string) => Promise<SharePointSite[]>;

/**
 * Walks every subsite beneath `root_site_id`, breadth-first. A site whose listing fails is
 * recorded in `errors` and the traversal continues, so one inaccessible subtree never hides the
 * rest. A cancellation or a rejected token ends the walk instead.
 */
export async function enumerate_subsite_tree(
  root_site_id: string,
  fetch_direct_subsites: DirectSubsiteFetcher,
): Promise<SharePointSubsiteTree> {
  const sites: SharePointSite[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const visited = new Set<string>([root_site_id]);
  let frontier = [root_site_id];

  for (let depth = 0; depth < MAX_SUBSITE_DEPTH && frontier.length > 0; depth++) {
    const children = await collect_direct_subsites(frontier, fetch_direct_subsites, errors);

    frontier = [];
    for (const child of children) {
      if (visited.has(child.site_id)) continue;
      visited.add(child.site_id);
      sites.push(child);
      frontier.push(child.site_id);
    }
  }

  if (frontier.length > 0) {
    warnings.push(
      `Subsite nesting exceeded ${MAX_SUBSITE_DEPTH} levels; deeper subsites are NOT covered by this backup.`,
    );
  }

  return { sites, warnings, errors };
}

/**
 * Fetches the direct subsites of every site in one level. A site that cannot be read is recorded
 * in `errors` and skipped, so one inaccessible subtree never aborts the traversal or masquerades
 * as "no subsites". Two failures are not recorded: a cancellation is rethrown so the run ends as
 * an interrupt, and a rejected token is rethrown as an `AuthError` so the run ends with the auth
 * exit code, because no other site can succeed either.
 */
async function collect_direct_subsites(
  parent_site_ids: string[],
  fetch_direct_subsites: DirectSubsiteFetcher,
  errors: string[],
): Promise<SharePointSite[]> {
  const children: SharePointSite[] = [];

  for (const parent_site_id of parent_site_ids) {
    try {
      append_all(children, await fetch_direct_subsites(parent_site_id));
    } catch (err) {
      if (is_cancellation_of(err, get_active_abort_signal())) throw err;
      if (is_authentication_failure(err)) throw as_auth_error(parent_site_id, err);
      errors.push(listing_failure_message(parent_site_id, err));
    }
  }

  return children;
}

/** Graph answers 401 when the token itself is rejected, unlike 403, which is one site refusing. */
function is_authentication_failure(err: unknown): boolean {
  if (err instanceof AuthError) return true;
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 401;
}

function as_auth_error(parent_site_id: string, err: unknown): AuthError {
  if (err instanceof AuthError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new AuthError(
    `Microsoft Graph rejected the credentials while listing subsites of ${parent_site_id}: ${detail}`,
    { cause: err },
  );
}

function listing_failure_message(parent_site_id: string, err: unknown): string {
  return (
    `Could not list subsites of ${parent_site_id}: ` +
    `${err instanceof Error ? err.message : String(err)}. ` +
    'Any subsites beneath it are NOT covered by this backup.'
  );
}
