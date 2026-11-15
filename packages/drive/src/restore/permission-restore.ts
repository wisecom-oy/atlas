import type {
  DrivePermission,
  DrivePermissionGrantee,
  DriveRecipient,
  DriveSharingConnector,
  DriveSharingWriteOutcome,
} from '@wisecom/atlas-types';
import {
  describe_permission,
  is_reapplicable_permission,
} from '@/permissions/permission-description';
import { describe_refusal, type SharingRestoreTally } from '@/restore/sharing-restore-tally';

/** Roles `invite` can grant. */
const INVITABLE_ROLES = new Set(['read', 'write']);

/** The Graph calls a permission restore makes. */
export type PermissionWriter = Pick<
  DriveSharingConnector,
  'grant_item_access' | 'create_item_link'
>;

/** Where the permissions go, and the snapshot path they are reported under. */
export interface PermissionRestoreTarget {
  readonly drive_id: string;
  readonly item_id: string;
  readonly path: string;
}

/** A permission that is not sent, with the reason, or the request outcome for one that was. */
type PlannedOutcome =
  DriveSharingWriteOutcome | { readonly status: 'skipped'; readonly reason: string };

/**
 * Reapplies an item's captured grants and links. Grants go through `invite` with no invitation
 * email and sign-in required; links are created anew with the stored type and scope, so they get
 * new URLs. Each permission that cannot be reapplied is recorded with its reason and the restore
 * carries on. `owner` grants are never sent (see {@link is_reapplicable_permission}).
 */
export async function restore_item_permissions(
  writer: PermissionWriter,
  target: PermissionRestoreTarget,
  permissions: readonly DrivePermission[],
  tally: SharingRestoreTally,
  now: Date = new Date(),
): Promise<void> {
  for (const permission of permissions.filter(is_reapplicable_permission)) {
    const outcome = is_link(permission)
      ? await restore_link(writer, target, permission, now)
      : await restore_grant(writer, target, permission);
    record_outcome(tally, target.path, permission, outcome);
  }
}

type LinkPermission = DrivePermission & { link: NonNullable<DrivePermission['link']> };

function is_link(permission: DrivePermission): permission is LinkPermission {
  return permission.link !== undefined;
}

function record_outcome(
  tally: SharingRestoreTally,
  path: string,
  permission: DrivePermission,
  outcome: PlannedOutcome,
): void {
  if (outcome.status === 'applied') {
    tally.permission_applied();
    return;
  }
  const reason =
    outcome.status === 'skipped'
      ? outcome.reason
      : describe_refusal(outcome.refusal, outcome.message);
  tally.permission_skipped(path, describe_permission(permission), reason);
}

/**
 * Recreates a sharing link. A password-protected link is skipped: its password is not readable, and
 * recreating the link without one would open the item wider than it was. An expired link is skipped
 * rather than recreated without an expiry, which would reopen access that had lapsed.
 */
async function restore_link(
  writer: PermissionWriter,
  target: PermissionRestoreTarget,
  permission: LinkPermission,
  now: Date,
): Promise<PlannedOutcome> {
  if (permission.has_password === true) {
    return {
      status: 'skipped',
      reason: 'password-protected link; the password cannot be restored',
    };
  }
  if (permission.expires_at !== undefined && Date.parse(permission.expires_at) <= now.getTime()) {
    return { status: 'skipped', reason: 'expired' };
  }
  const recipients = (permission.granted_to_identities ?? [])
    .map(to_recipient)
    .filter((recipient): recipient is DriveRecipient => recipient !== undefined);
  if (permission.link.scope === 'users' && recipients.length === 0) {
    return { status: 'skipped', reason: 'specific-people link with no recorded recipients' };
  }
  return writer.create_item_link(target.drive_id, target.item_id, {
    type: permission.link.type,
    scope: permission.link.scope,
    ...(permission.expires_at !== undefined && { expires_at: permission.expires_at }),
    ...(recipients.length > 0 && { recipients }),
  });
}

/** Reapplies a direct grant, by object id first and by address when the id no longer resolves. */
async function restore_grant(
  writer: PermissionWriter,
  target: PermissionRestoreTarget,
  permission: DrivePermission,
): Promise<PlannedOutcome> {
  const grantee = permission.granted_to;
  const refusal = unsupported_grant_reason(grantee);
  if (refusal !== undefined || grantee === undefined) {
    return { status: 'skipped', reason: refusal ?? 'no grantee recorded' };
  }
  const roles = permission.roles.filter((role) => INVITABLE_ROLES.has(role));
  if (roles.length === 0) {
    return {
      status: 'skipped',
      reason: `role ${permission.roles.join('+')} cannot be granted through invite`,
    };
  }
  const by_id = id_recipient(grantee);
  if (by_id) {
    const outcome = await writer.grant_item_access(target.drive_id, target.item_id, {
      recipient: by_id,
      roles,
    });
    if (outcome.status === 'applied' || outcome.refusal !== 'principal_unresolved') return outcome;
    if (!grantee.email) return outcome;
  }
  if (!grantee.email) return { status: 'skipped', reason: 'grantee has no object id or address' };
  return writer.grant_item_access(target.drive_id, target.item_id, {
    recipient: { email: grantee.email },
    roles,
  });
}

/** Why a grantee kind cannot be re-granted through `invite`, or undefined when it can. */
function unsupported_grant_reason(grantee: DrivePermissionGrantee | undefined): string | undefined {
  if (grantee?.type === 'site_group') {
    return 'SharePoint site group; grant it again from the site permissions';
  }
  if (grantee?.type === 'application' || grantee?.type === 'device') {
    return `${grantee.type} grants are not re-granted`;
  }
  return undefined;
}

/** An Entra user or group addressed by object id; SharePoint principal ids are not Entra ids. */
function id_recipient(grantee: DrivePermissionGrantee): DriveRecipient | undefined {
  if ((grantee.type === 'user' || grantee.type === 'group') && grantee.id) {
    return { object_id: grantee.id };
  }
  return undefined;
}

function to_recipient(grantee: DrivePermissionGrantee): DriveRecipient | undefined {
  return id_recipient(grantee) ?? (grantee.email ? { email: grantee.email } : undefined);
}

/** How many of the permissions a restore would reapply, for the "not requested" count. */
export function count_reapplicable_permissions(
  permissions: readonly DrivePermission[] | undefined,
): number {
  return (permissions ?? []).filter(is_reapplicable_permission).length;
}
