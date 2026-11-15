import { classify_download_failure, read_graph_error_code } from '@wisecom/atlas-m365-graph';
import {
  GraphAccessRefusedError,
  MissingGraphPermissionsError,
  type RefusedGraphResource,
} from '@wisecom/atlas-types';
import type { DriveWorkload } from '@/drive-ports';
import { DRIVE_WORKLOAD_LABEL } from '@/backup/drive-workload-label';
import type { DriveGraphClient } from '@/backup/graph-item-content';

/**
 * Tells a missing grant from a refusal of one resource when Graph answers a drive enumeration call
 * with 403 (issue #772).
 *
 * Graph answers both with the same `accessDenied` code: a SharePoint Embedded container site is
 * refused to an app holding `Sites.ReadWrite.All` with exactly the body a missing grant gets. So
 * the error alone cannot say which it is. A provider that can tell supplies `verify_read_grant`, one
 * request every holder of the grant may make. When it succeeds, Atlas reports a refusal of this
 * resource rather than a missing grant. It shows only that the app can read that resource: an app
 * on per-site grants that cover it passes too, so the refusal message names the per-site remedy.
 */

/** Whether the app can read a resource every holder of the read grant can read. */
export type ReadGrantCheck = (client: DriveGraphClient) => Promise<boolean>;

/** The provider values the denial classification reads. */
export interface DenialBinding {
  readonly workload: DriveWorkload;
  /** The application permissions a missing-grant error names, e.g. `['Sites.Read.All']`. */
  readonly read_permissions: readonly string[];
  /** A narrower grant that also works, named after the permissions, e.g. a `Sites.Selected` grant. */
  readonly grant_alternative?: string | undefined;
  /** Reads a resource every holder of the grant can read; absent when the provider has none. */
  readonly verify_read_grant?: ReadGrantCheck | undefined;
}

/** What a refused enumeration call addressed. */
export interface DeniedResource extends RefusedGraphResource {
  /** How messages name it, e.g. `site <id>`. */
  readonly label: string;
  /** True when the caller knows the site's web URL is a SharePoint Embedded container's. */
  readonly is_file_storage_container?: boolean | undefined;
}

/**
 * How long one grant check answers for its Graph client. One client serves one tenant, so a run
 * that meets several refused sites checks once, while a long-lived SDK process still notices a
 * grant revoked or added later.
 */
const GRANT_CHECK_TTL_MS = 10 * 60_000;

interface CachedGrantCheck {
  readonly expires_at: number;
  readonly answer: Promise<boolean>;
}

const grant_checks = new WeakMap<DriveGraphClient, CachedGrantCheck>();

/** Rethrows a Graph 403 from an enumeration call as a typed error, and returns for anything else. */
export async function rethrow_enumeration_denial(
  binding: DenialBinding,
  client: DriveGraphClient,
  err: unknown,
  resource: DeniedResource,
): Promise<void> {
  if (graph_status_of(err) !== 403) return;
  if (classify_download_failure(err) !== 'missing_permission') {
    throw access_refused_error(binding, err, resource, 'code');
  }
  if (binding.verify_read_grant === undefined) {
    throw missing_permissions_error(binding, err, `for ${resource.label}`);
  }
  if (await check_read_grant_once(binding.verify_read_grant, client)) {
    throw access_refused_error(binding, err, resource, 'grant');
  }
  throw missing_permissions_error(
    binding,
    err,
    `for ${resource.label} and for the tenant's root site`,
  );
}

/**
 * The missing-grant error for a 403 whose code means a missing grant. Names the HTTP status, the
 * Graph code, what was refused, and the permissions to grant.
 */
export function missing_permissions_error(
  binding: DenialBinding,
  err: unknown,
  refused: string,
): MissingGraphPermissionsError {
  const graph_code = read_graph_error_code(err);
  const label = DRIVE_WORKLOAD_LABEL[binding.workload];
  const alternative =
    binding.grant_alternative === undefined ? '' : `, or ${binding.grant_alternative}`;
  return new MissingGraphPermissionsError(
    `Microsoft Graph returned HTTP 403 ${graph_code} ${refused}. The app registration needs the ` +
      `${label} application permissions ${binding.read_permissions.join(', ')} with admin ` +
      `consent${alternative}.`,
    { permissions: binding.read_permissions, status_code: 403, graph_code, cause: err },
  );
}

/** Runs the grant check, reusing a definite answer for its client until it expires. */
async function check_read_grant_once(
  verify_read_grant: ReadGrantCheck,
  client: DriveGraphClient,
): Promise<boolean> {
  const cached = grant_checks.get(client);
  if (cached !== undefined && cached.expires_at > Date.now()) return await cached.answer;
  const answer = verify_read_grant(client);
  grant_checks.set(client, { expires_at: Date.now() + GRANT_CHECK_TTL_MS, answer });
  try {
    return await answer;
  } catch (check_err) {
    // A check that failed says nothing about the grant, so the next refusal asks again.
    grant_checks.delete(client);
    throw check_err;
  }
}

/** The refusal of one resource, worded for why Atlas did not report it as a missing grant. */
function access_refused_error(
  binding: DenialBinding,
  err: unknown,
  resource: DeniedResource,
  known_by: 'code' | 'grant',
): GraphAccessRefusedError {
  const graph_code = read_graph_error_code(err);
  const label = DRIVE_WORKLOAD_LABEL[binding.workload];
  const container = resource.is_file_storage_container === true;
  return new GraphAccessRefusedError(
    `Microsoft Graph refused ${label} ${resource.label}: HTTP 403 ${graph_code}. ` +
      refusal_explanation(binding, known_by, container),
    { site_id: resource.site_id, drive_id: resource.drive_id, owner_id: resource.owner_id },
    container ? 'file_storage_container' : 'access_refused',
    { status_code: 403, graph_code, cause: err },
  );
}

/**
 * Why Atlas reports a refusal rather than a missing grant, and what to do about it. A readable root
 * site shows only that: an app on `Sites.Read.All` reads it, and so does an app whose `Sites.Selected`
 * grants include it but not this site. The message states the observation, not which grant the app
 * holds, and names the per-site remedy alongside the container case.
 */
function refusal_explanation(
  binding: DenialBinding,
  known_by: 'code' | 'grant',
  container: boolean,
): string {
  if (container) {
    return (
      'Its URL is under /contentstorage/: it is a SharePoint Embedded container, which needs ' +
      'FileStorageContainer.Selected. Atlas does not back these up; leave it out of the run.'
    );
  }
  if (known_by === 'code') {
    return 'The code does not name a missing permission. Retrying returns the same answer.';
  }
  const per_site =
    binding.grant_alternative === undefined
      ? ''
      : ` If the app registration uses per-site grants, it needs ${binding.grant_alternative}.`;
  return (
    "The same app can read the tenant's root site, so Graph refused this resource alone. A " +
    'SharePoint Embedded container site (URL under /contentstorage/) is refused this way: leave ' +
    `it out of the run, since retrying returns the same answer.${per_site}`
  );
}

/** The HTTP status a Graph error carries, or undefined. */
function graph_status_of(err: unknown): unknown {
  return err !== null && typeof err === 'object' && 'statusCode' in err
    ? err.statusCode
    : undefined;
}
