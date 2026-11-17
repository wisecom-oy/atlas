/**
 * Sharing state captured for a drive item: the item's own (non-inherited) Graph `permission`
 * resources, reduced to the fields that say who had access and how.
 *
 * Never holds a sharing link's `webUrl`, a `shareId`, an invitation URL or any other token. An
 * anonymous link's URL is a bearer credential, and Graph cannot recreate a link with a given URL,
 * so storing one would make the backup a store of working share links for no restore benefit.
 *
 * @see https://learn.microsoft.com/en-us/graph/api/resources/permission
 */

/** What kind of principal a grant names, after reading Graph's `sharePointIdentitySet`. */
export type DrivePermissionGranteeType =
  'user' | 'group' | 'site_user' | 'site_group' | 'application' | 'device';

/** One principal a permission grants access to. */
export interface DrivePermissionGrantee {
  readonly type: DrivePermissionGranteeType;
  /** Entra object ID for a user or group, the SharePoint principal id for a site principal. */
  readonly id?: string;
  readonly display_name?: string;
  readonly email?: string;
  /** SharePoint claims login name, as Graph returns it on `siteUser`. */
  readonly login_name?: string;
}

/** The shape of a sharing link, without its URL. */
export interface DriveSharingLink {
  /** Graph `link.type`: `view`, `edit`, `embed`, `blocksDownload` and so on. */
  readonly type: string;
  /** Graph `link.scope`: `anonymous`, `organization`, `users` or `existingAccess`. */
  readonly scope: string;
  readonly prevents_download?: boolean;
}

/** One non-inherited permission on a drive item. */
export interface DrivePermission {
  /** Graph `roles`, such as `read`, `write` or `owner`. */
  readonly roles: readonly string[];
  /** Present when the permission is a sharing link rather than a direct grant. */
  readonly link?: DriveSharingLink;
  /** ISO 8601 UTC. Graph `expirationDateTime`. */
  readonly expires_at?: string;
  /** Graph `hasPassword`. A password-protected link cannot be recreated with its password. */
  readonly has_password?: boolean;
  /** Graph `grantedToV2`: the principal of a direct grant. */
  readonly granted_to?: DrivePermissionGrantee;
  /** Graph `grantedToIdentitiesV2`: who a specific-people link was shared with. */
  readonly granted_to_identities?: readonly DrivePermissionGrantee[];
}

/**
 * What a manifest entry records. Absent on an entry means `file`, which is every entry written
 * before folder metadata was captured.
 */
export type DriveEntryKind = 'file' | 'folder';
