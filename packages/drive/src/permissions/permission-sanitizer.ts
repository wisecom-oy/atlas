import type {
  DrivePermission,
  DrivePermissionGrantee,
  DrivePermissionGranteeType,
  DriveSharingLink,
} from '@wisecom/atlas-types';

/** One identity inside Graph's `sharePointIdentitySet`. */
interface GraphIdentity {
  id?: unknown;
  displayName?: unknown;
  email?: unknown;
  loginName?: unknown;
}

/** Graph `sharePointIdentitySet`, as `grantedToV2` and `grantedToIdentitiesV2` carry it. */
interface GraphSharePointIdentitySet {
  user?: GraphIdentity;
  group?: GraphIdentity;
  siteUser?: GraphIdentity;
  siteGroup?: GraphIdentity;
  application?: GraphIdentity;
  device?: GraphIdentity;
}

/** The Graph `permission` fields this module reads. Everything else is dropped unread. */
interface GraphPermission {
  roles?: unknown;
  link?: { type?: unknown; scope?: unknown; preventsDownload?: unknown };
  expirationDateTime?: unknown;
  hasPassword?: unknown;
  inheritedFrom?: unknown;
  grantedToV2?: GraphSharePointIdentitySet;
  grantedToIdentitiesV2?: GraphSharePointIdentitySet[];
}

/**
 * Reduces Graph `permission` resources to what a backup may keep: the item's own permissions,
 * with roles, link shape, expiry, the password flag and grantee identities.
 *
 * Built by allow-list, never by copying and deleting: a sharing link's `webUrl`, `shareId`,
 * `invitation` and any field Graph adds later cannot reach a manifest, because nothing here reads
 * them. An anonymous link's URL is a bearer credential. Inherited permissions are dropped, because
 * the parent's entry implies them and keeping them would repeat the parent's list on every child.
 */
export function sanitize_graph_permissions(raw: readonly unknown[]): DrivePermission[] {
  const kept: DrivePermission[] = [];
  for (const candidate of raw) {
    if (!is_object(candidate)) continue;
    const permission = candidate as GraphPermission;
    if (is_inherited(permission)) continue;
    const sanitized = sanitize_permission(permission);
    if (sanitized) kept.push(sanitized);
  }
  return kept;
}

/** Graph marks an inherited permission with `inheritedFrom`, an empty object for the drive root. */
function is_inherited(permission: GraphPermission): boolean {
  return permission.inheritedFrom !== undefined && permission.inheritedFrom !== null;
}

function sanitize_permission(permission: GraphPermission): DrivePermission | undefined {
  const roles = string_list(permission.roles);
  if (roles.length === 0) return undefined;
  const link = sanitize_link(permission.link);
  const granted_to = sanitize_identity_set(permission.grantedToV2);
  const identities = (
    Array.isArray(permission.grantedToIdentitiesV2) ? permission.grantedToIdentitiesV2 : []
  )
    .map((set) => sanitize_identity_set(set))
    .filter((grantee): grantee is DrivePermissionGrantee => grantee !== undefined);
  const expires_at = text(permission.expirationDateTime);
  return {
    roles,
    ...(link ? { link } : {}),
    ...(expires_at ? { expires_at } : {}),
    ...(permission.hasPassword === true ? { has_password: true } : {}),
    ...(granted_to ? { granted_to } : {}),
    ...(identities.length > 0 ? { granted_to_identities: identities } : {}),
  };
}

function sanitize_link(link: GraphPermission['link']): DriveSharingLink | undefined {
  if (!is_object(link)) return undefined;
  const type = text(link.type);
  const scope = text(link.scope);
  if (!type || !scope) return undefined;
  return {
    type,
    scope,
    ...(link.preventsDownload === true ? { prevents_download: true } : {}),
  };
}

/**
 * The principal a `sharePointIdentitySet` names. An Entra user or group wins over the SharePoint
 * principal Graph pairs with it, because that is what a grant can be reapplied to; the SharePoint
 * login name is kept alongside for the audit trail.
 */
function sanitize_identity_set(
  set: GraphSharePointIdentitySet | undefined,
): DrivePermissionGrantee | undefined {
  if (typeof set !== 'object' || set === null) return undefined;
  const site_login = text(set.siteUser?.loginName);
  const order: Array<[DrivePermissionGranteeType, GraphIdentity | undefined]> = [
    ['user', set.user],
    ['group', set.group],
    ['site_group', set.siteGroup],
    ['site_user', set.siteUser],
    ['application', set.application],
    ['device', set.device],
  ];
  for (const [type, identity] of order) {
    if (!is_object(identity)) continue;
    const login_name = text(identity.loginName) ?? (type === 'user' ? site_login : undefined);
    return compact_grantee(type, identity, login_name);
  }
  return undefined;
}

function compact_grantee(
  type: DrivePermissionGranteeType,
  identity: GraphIdentity,
  login_name: string | undefined,
): DrivePermissionGrantee {
  const id = text(identity.id);
  const display_name = text(identity.displayName);
  const email = text(identity.email);
  return {
    type,
    ...(id ? { id } : {}),
    ...(display_name ? { display_name } : {}),
    ...(email ? { email } : {}),
    ...(login_name ? { login_name } : {}),
  };
}

function is_object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function string_list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
