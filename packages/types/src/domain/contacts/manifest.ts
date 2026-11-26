import type { NotFoundStreak } from '@/domain/shared/failed-item';

/** A contact folder as captured in a snapshot. `path` is the display-name chain below the default Contacts folder; the default folder itself has an empty path. */
export interface ContactFolderRecord {
  readonly folder_id: string;
  readonly display_name: string;
  readonly path: readonly string[];
}

/** One contact in a snapshot. The contact JSON and its photo are separate content-addressed encrypted objects. */
export interface ContactManifestEntry {
  readonly contact_id: string;
  readonly folder_id: string;
  readonly display_name?: string | undefined;
  readonly last_modified_at?: string | undefined;
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly photo_storage_key?: string | undefined;
  readonly photo_checksum?: string | undefined;
  readonly photo_size_bytes?: number | undefined;
  /**
   * Consecutive runs whose photo request answered "not found" for a contact Exchange lists as
   * carrying an attachment. A contact whose attachment is not a photo answers so on every run, and
   * so can a contact with a photo during an incident, so the photo is requested again on later runs
   * until the streak confirms there is none (issue #854). Absent on entries written before 7.2.1.
   */
  readonly photo_not_found?: NotFoundStreak | undefined;
}

/**
 * A full, self-contained view of a mailbox's contacts at backup time. Unlike mail and drive
 * manifests there is no chain to fold: each snapshot lists every folder and contact, and
 * unchanged contacts point at the same content-addressed objects as the previous snapshot.
 */
export interface ContactsSnapshotManifest {
  readonly id: string;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: string;
  readonly total_contacts: number;
  readonly total_size_bytes: number;
  readonly folders: readonly ContactFolderRecord[];
  readonly entries: readonly ContactManifestEntry[];
}

/** Per-folder Graph contact delta links, persisted between runs. */
export interface ContactsDeltaCursor {
  readonly mailbox_id: string;
  readonly delta_link_by_folder: Readonly<Record<string, string>>;
  readonly updated_at: string;
  /**
   * The head snapshot when the cursor was saved. The links are resumed only while it is still the
   * newest readable manifest (issue #704). Absent on cursors written before 7.0.
   */
  readonly snapshot_id?: string;
}
