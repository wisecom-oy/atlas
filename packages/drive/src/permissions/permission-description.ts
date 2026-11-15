import type { DrivePermission, DrivePermissionGrantee } from '@wisecom/atlas-types';

/** A grantee as an operator reads it: name and address when known, else the id. */
export function describe_grantee(grantee: DrivePermissionGrantee | undefined): string {
  if (!grantee) return 'unknown grantee';
  const label = grantee.display_name ?? grantee.login_name ?? grantee.id ?? grantee.type;
  return grantee.email ? `${label} <${grantee.email}>` : label;
}

/** One line naming a permission, such as `link edit/organization` or `grant write to Jane Roe`. */
export function describe_permission(permission: DrivePermission): string {
  const roles = permission.roles.join('+');
  if (permission.link) return `link ${permission.link.type}/${permission.link.scope} (${roles})`;
  return `grant ${roles} to ${describe_grantee(permission.granted_to)}`;
}

/**
 * Whether a restore reapplies this permission. `owner` grants are not: `invite` cannot grant the
 * owner role, and the restore target's owner already holds it. They stay in the backup so "who had
 * access" is complete, and are left out of the applied and skipped counts.
 */
export function is_reapplicable_permission(permission: DrivePermission): boolean {
  return !permission.roles.includes('owner');
}
