import type { DriveFileSystemInfo, DriveItemIdentity } from '@wisecom/atlas-types';

/** The `identitySet` shape Graph uses for `createdBy` and `lastModifiedBy`. */
export interface GraphIdentitySet {
  user?: GraphIdentity;
  application?: GraphIdentity;
  device?: GraphIdentity;
}

interface GraphIdentity {
  displayName?: string;
  email?: string;
  id?: string;
}

/** The `fileSystemInfo` facet as Graph returns it. */
export interface GraphFileSystemInfo {
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

/**
 * Maps a Graph `identitySet` to the one identity worth recording.
 *
 * A set can carry a user, an application, and a device at once. The user is
 * the answer to "who did this" whenever there is one; an application identity
 * is what remains when a service account or workflow made the change, and it
 * is still better than recording nothing. Returns undefined when the set is
 * absent or empty, so an absent author never becomes an empty object in a
 * manifest.
 */
export function map_graph_identity(
  identity_set: GraphIdentitySet | undefined,
): DriveItemIdentity | undefined {
  const identity = identity_set?.user ?? identity_set?.application ?? identity_set?.device;
  if (!identity) return undefined;

  const mapped: DriveItemIdentity = {
    ...(identity.displayName ? { display_name: identity.displayName } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.id ? { id: identity.id } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/**
 * Maps the `fileSystemInfo` facet, dropping it when Graph reported neither
 * timestamp so a manifest does not carry an empty object.
 */
export function map_graph_file_system_info(
  raw: GraphFileSystemInfo | undefined,
): DriveFileSystemInfo | undefined {
  if (!raw) return undefined;

  const mapped: DriveFileSystemInfo = {
    ...(raw.createdDateTime ? { created_at: raw.createdDateTime } : {}),
    ...(raw.lastModifiedDateTime ? { last_modified_at: raw.lastModifiedDateTime } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/**
 * Builds the `fileSystemInfo` an upload should carry, so a restored file keeps
 * the timestamps it had rather than the moment it was restored.
 *
 * Returns undefined when nothing was captured, which keeps the request body
 * identical to what it was before this existed.
 */
export function build_upload_file_system_info(
  info: DriveFileSystemInfo | undefined,
): GraphFileSystemInfo | undefined {
  if (!info) return undefined;

  const body: GraphFileSystemInfo = {
    ...(info.created_at ? { createdDateTime: info.created_at } : {}),
    ...(info.last_modified_at ? { lastModifiedDateTime: info.last_modified_at } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}
