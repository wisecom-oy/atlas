/**
 * Metadata that describes a drive item beyond its bytes.
 *
 * Kept in one place because OneDrive and SharePoint manifests record the same
 * facts about a `driveItem`, and the two manifest shapes are otherwise twins
 * that have already drifted once.
 */

/** A user or application Graph attributes an action to. */
export interface DriveItemIdentity {
  readonly display_name?: string;
  readonly email?: string;
  /** Entra object ID for a user, or the application ID for an app identity. */
  readonly id?: string;
}

/**
 * Client-side timestamps from the Graph `fileSystemInfo` facet.
 *
 * Deliberately separate from a manifest's `last_modified_at`, which is the
 * service-side `driveItem.lastModifiedDateTime`. The two differ, and the
 * distinction is the whole point: the service values are when Microsoft 365
 * saw the file, so after a restore they say "now". These are the values the
 * client reported, they are writable on upload, and so they are the ones that
 * can survive a restore.
 *
 * @see https://learn.microsoft.com/en-us/graph/api/resources/filesysteminfo
 */
export interface DriveFileSystemInfo {
  /** ISO 8601 UTC. Graph `fileSystemInfo.createdDateTime`. */
  readonly created_at?: string;
  /** ISO 8601 UTC. Graph `fileSystemInfo.lastModifiedDateTime`. */
  readonly last_modified_at?: string;
}

/**
 * The fields needed to fetch one stored blob back out of object storage.
 *
 * A manifest entry and a version index row both satisfy this. That is the
 * point: restoring a historical version is the same operation as restoring a
 * file, differing only in which bytes are named.
 */
export interface StoredBlobRef {
  readonly storage_key?: string | undefined;
  readonly checksum?: string | undefined;
  readonly file_name: string;
  readonly size_bytes: number;
}

/**
 * A folder's colour, read from the `_ColorHex`, `_ColorTag` and `_Emoji` columns of its list item.
 * The colour is not on the `driveItem` and delta cannot carry it, so backup reads it separately.
 * Only non-empty values are kept; a folder without a colour stores none of them.
 */
export interface DriveFolderColor {
  /** `_ColorHex`: the palette index the web UI wrote, a string such as `"6"`, not a hex value. */
  readonly color_hex?: string;
  /** `_ColorTag`. */
  readonly color_tag?: string;
  /** `_Emoji`. */
  readonly emoji?: string;
}
