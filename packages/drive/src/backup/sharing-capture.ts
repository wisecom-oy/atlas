import type { DrivePermission, DriveSharingConnector } from '@wisecom/atlas-types';
import type { DriveDeltaItem, DriveManifestEntry } from '@/drive-ports';
import { digest_permissions } from '@/permissions/permission-digest';
import { NO_PREVIOUS_ENTRIES, type PreviousEntryLookup } from '@/backup/previous-entry-lookup';

/** The cursor map the capture reads and updates. */
export interface PermissionDigestTracking {
  permission_digest_by_item_id?: Record<string, string>;
}

/** What a run learned about one item's permissions. */
export type PermissionObservation =
  | { readonly read: false }
  | {
      readonly read: true;
      readonly permissions: readonly DrivePermission[];
      readonly digest: string;
      /** The permissions differ from what the cursor last recorded for the item. */
      readonly changed: boolean;
    };

const NOT_READ: PermissionObservation = { read: false };

/** The digest of "no permissions", which is what an item with no recorded digest had. */
const EMPTY_DIGEST = digest_permissions([]);

/** The cursor's digest map, created on first use for cursors written before it existed. */
export function permission_digests(tracking: PermissionDigestTracking): Record<string, string> {
  tracking.permission_digest_by_item_id ??= {};
  return tracking.permission_digest_by_item_id;
}

/**
 * Whether an item's permissions are worth reading this run: a live item, other than the root, that
 * Graph re-presented with a `shared` facet, or that had permissions last time (so
 * their removal is seen even if the facet is absent).
 */
export function is_permission_candidate(
  item: DriveDeltaItem,
  tracking: PermissionDigestTracking,
): boolean {
  if (item.deleted || item.is_root === true) return false;
  return (
    item.sharing_facet === true ||
    tracking.permission_digest_by_item_id?.[item.item_id] !== undefined
  );
}

/**
 * Reads and remembers permissions for one backup run. Delta items are read in `$batch` requests
 * ahead of processing; an item that was not read ahead (a retried failure) is read on its own.
 */
export class DriveSharingCapture {
  private readonly _fetched = new Map<string, readonly DrivePermission[]>();
  /** Items already asked for, read or not, so a failed read is not repeated within the run. */
  private readonly _attempted = new Set<string>();

  constructor(
    private readonly _connector: Pick<DriveSharingConnector, 'fetch_item_permissions'>,
    private readonly _find_previous: PreviousEntryLookup = NO_PREVIOUS_ENTRIES,
  ) {}

  /** Reads the permissions of every candidate in `items`, 20 items per Graph request. */
  async prefetch(
    drive_id: string,
    items: readonly DriveDeltaItem[],
    tracking: PermissionDigestTracking,
  ): Promise<void> {
    const ids = items
      .filter(
        (item) => is_permission_candidate(item, tracking) && !this._attempted.has(item.item_id),
      )
      .map((item) => item.item_id);
    if (ids.length === 0) return;
    for (const id of ids) this._attempted.add(id);
    const fetched = await this._connector.fetch_item_permissions(drive_id, ids);
    for (const [item_id, permissions] of fetched) this._fetched.set(item_id, permissions);
  }

  /** What the run knows about the item's permissions, compared with the cursor's digest. */
  async observe(
    item: DriveDeltaItem,
    tracking: PermissionDigestTracking,
  ): Promise<PermissionObservation> {
    if (!is_permission_candidate(item, tracking)) return NOT_READ;
    if (!this._attempted.has(item.item_id)) await this.prefetch(item.drive_id, [item], tracking);
    const permissions = this._fetched.get(item.item_id);
    if (permissions === undefined) return NOT_READ;
    const digest = digest_permissions(permissions);
    const previous = tracking.permission_digest_by_item_id?.[item.item_id] ?? EMPTY_DIGEST;
    return { read: true, permissions, digest, changed: digest !== previous };
  }

  /** The newest entry an earlier snapshot holds for the file. */
  find_previous_entry(file_id: string): Promise<DriveManifestEntry | undefined> {
    return this._find_previous(file_id);
  }
}

/**
 * Records in the cursor what a file entry written this run holds. A read with permissions stores
 * the digest; a read with none clears it. A candidate whose read failed also clears it, so the next
 * time Graph re-presents the item its permissions are read again rather than assumed unchanged.
 */
export function record_file_permission_digest(
  tracking: PermissionDigestTracking,
  item_id: string,
  observation: PermissionObservation,
): void {
  const digests = permission_digests(tracking);
  if (observation.read && observation.permissions.length > 0) digests[item_id] = observation.digest;
  else delete digests[item_id];
}

/** The entry with the permissions the run read, when it read any. */
export function with_captured_permissions<TEntry extends object>(
  entry: TEntry,
  observation: PermissionObservation,
): TEntry {
  if (!observation.read || observation.permissions.length === 0) return entry;
  return { ...entry, permissions: observation.permissions };
}
