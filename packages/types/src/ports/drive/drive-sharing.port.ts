import type { DrivePermission } from '@/domain/drive/permission';

/**
 * Why Graph refused a sharing write. Each is a per-item outcome a restore reports and moves past,
 * never a failure of the run.
 *
 * - `principal_unresolved`: the grantee no longer exists or cannot be resolved in this tenant.
 * - `sharing_disabled`: tenant or site policy forbids this kind of sharing (for example anonymous links).
 * - `rejected`: any other refusal; the message says what Graph answered.
 */
export type DriveSharingRefusal = 'principal_unresolved' | 'sharing_disabled' | 'rejected';

/** The result of one sharing write. */
export type DriveSharingWriteOutcome =
  | { readonly status: 'applied' }
  | {
      readonly status: 'refused';
      readonly refusal: DriveSharingRefusal;
      readonly message: string;
    };

/** One principal addressed by a grant or a specific-people link. */
export interface DriveRecipient {
  readonly object_id?: string;
  readonly email?: string;
}

/** A direct grant, sent through `invite` with no invitation email. */
export interface DriveAccessGrantRequest {
  readonly recipient: DriveRecipient;
  readonly roles: readonly string[];
}

/** A sharing link to create. Graph issues a new URL; the old one is never reused. */
export interface DriveLinkRequest {
  readonly type: string;
  readonly scope: string;
  /** ISO 8601 UTC, only when still in the future. */
  readonly expires_at?: string;
  /** Who a `users`-scope link is shared with. */
  readonly recipients?: readonly DriveRecipient[];
}

/**
 * The Graph calls that read and write a drive item's sharing. Both `OneDriveConnector` and
 * `SharePointSiteConnector` include it, so the shared drive code drives either provider through
 * one surface.
 */
export interface DriveSharingConnector {
  /**
   * Reads the non-inherited permissions of each item, batched 20 to a request. An item missing from
   * the map could not be read; the caller must not treat that as "no permissions".
   */
  fetch_item_permissions(
    drive_id: string,
    item_ids: readonly string[],
  ): Promise<Map<string, DrivePermission[]>>;

  /** Grants direct access without sending an invitation email, requiring sign-in. */
  grant_item_access(
    drive_id: string,
    item_id: string,
    request: DriveAccessGrantRequest,
  ): Promise<DriveSharingWriteOutcome>;

  /** Creates a sharing link of the requested type and scope. */
  create_item_link(
    drive_id: string,
    item_id: string,
    request: DriveLinkRequest,
  ): Promise<DriveSharingWriteOutcome>;
}
