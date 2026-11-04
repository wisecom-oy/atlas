import type { FailedItemLedger } from '@/domain/failed-item';

/**
 * Layout version written into every Teams JSON object (snapshot index, channel shard, channel
 * cursor). Readers that meet a higher version raise `UnsupportedFormatVersionError` rather than
 * guessing at fields they do not know.
 */
export const TEAMS_FORMAT_VERSION = 1;

/**
 * A Microsoft Graph resource stored exactly as Graph returned it.
 *
 * Atlas reads only `id` and `displayName`. Every other field (authors, timestamps, mentions,
 * reactions, attachments, `etag`) is kept verbatim, because restore and export need the original
 * values and the migration API takes them unchanged.
 */
export interface TeamsGraphResource {
  readonly id: string;
  readonly displayName?: string;
  readonly [field: string]: unknown;
}

/** A stored object's location and integrity data. */
export interface TeamsStoredBlobRef {
  /** Key of the encrypted object. Derived from the keyed content name, not the plaintext hash. */
  readonly storage_key: string;
  /** Plain SHA-256 of the plaintext, checked by verification. */
  readonly checksum: string;
  readonly size_bytes: number;
}

/** An inline image or other `hostedContents` item, stored as raw bytes. */
export interface TeamsHostedRef extends TeamsStoredBlobRef {
  /** Graph `chatMessageHostedContent` `contentType`, when Graph reports one. */
  readonly content_type?: string | undefined;
}

/** The last live version of a message, kept once Graph reports the message deleted. */
export interface TeamsKeptMessageRef extends TeamsStoredBlobRef {
  /** Hosted content of that live version, keyed by hosted-content ID. */
  readonly hosted: Record<string, TeamsHostedRef>;
}

/**
 * One stored version of a channel message, root or reply. The blob is the raw Graph message JSON,
 * so a reply is never embedded in its root.
 */
export interface TeamsMessageRef extends TeamsStoredBlobRef {
  /** Graph `lastModifiedDateTime` of this version. */
  readonly last_modified_at: string;
  /** Set when Graph reports the message removed. `storage_key` then points at the tombstone. */
  readonly deleted_at?: string | undefined;
  /**
   * The last live version, with its hosted content. Set once, when the message first turns
   * deleted, and never overwritten, so the content of a deleted message stays restorable.
   */
  readonly kept?: TeamsKeptMessageRef | undefined;
  /** Hosted content of this version, keyed by hosted-content ID. */
  readonly hosted: Record<string, TeamsHostedRef>;
  /** Hosted-content IDs Graph referenced but did not return. The message is still stored without them. */
  readonly hosted_missing?: string[] | undefined;
}

/** One channel-root thread: the root message and its replies. */
export interface TeamsThread {
  readonly root: TeamsMessageRef;
  /** Reply refs keyed by reply ID. Deleted replies stay, with `deleted_at` set. */
  readonly replies: Record<string, TeamsMessageRef>;
  /** Set when the root is deleted. */
  readonly deleted_at?: string | undefined;
}

/** A thread together with the channel and root it belongs to, for flat listings. */
export interface TeamsThreadListing extends TeamsThread {
  readonly channel_id: string;
  readonly root_id: string;
}

/**
 * How a channel was read this run. `delta` used the channel's message delta link. `full` re-read
 * every root with `/messages`, because the channel has no email address, Graph rejected delta,
 * or the saved sync state had expired.
 */
export type TeamsChannelReadMode = 'delta' | 'full';

/** Graph `driveItem` location of a channel's Files folder, which Teams stores in SharePoint. */
export interface TeamsFilesFolderRef {
  readonly drive_id: string;
  readonly item_id: string;
  readonly web_url?: string | undefined;
}

/** One channel's row in the snapshot index. Its content lives in the shard it points to. */
export interface TeamsChannelIndexEntry {
  readonly channel_id: string;
  readonly display_name?: string | undefined;
  readonly shard_key: string;
  readonly shard_checksum: string;
  /** Set when Graph reports the channel gone. The entry is kept so its threads stay listable. */
  readonly deleted_at?: string | undefined;
  readonly thread_count: number;
  readonly message_count: number;
  readonly size_bytes: number;
}

/** Totals across every channel of one snapshot. */
export interface TeamsSnapshotTotals {
  readonly thread_count: number;
  readonly message_count: number;
  readonly size_bytes: number;
}

/**
 * The team-level object of one snapshot. Written last, so a snapshot exists only once every shard
 * it lists is in storage. Deleting it removes the snapshot; shards stay until they are unreferenced.
 */
export interface TeamsSnapshotIndex {
  /** `${team_id}-${snapshot_id}`, matching the SharePoint manifest id convention. */
  readonly id: string;
  readonly format_version: typeof TEAMS_FORMAT_VERSION;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name?: string | undefined;
  readonly snapshot_id: string;
  readonly created_at: Date;
  /** Raw Graph team object (`/teams/{id}`), settings included. */
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  readonly channels: TeamsChannelIndexEntry[];
  readonly totals: TeamsSnapshotTotals;
}

/**
 * The content of one channel at one point in time. Stored under the HMAC of its canonical JSON, so
 * an unchanged channel reuses the shard a previous snapshot already wrote.
 */
export interface TeamsChannelShard {
  readonly format_version: typeof TEAMS_FORMAT_VERSION;
  readonly team_id: string;
  readonly channel_id: string;
  /** Raw Graph channel object, including `membershipType` and `email`. */
  readonly channel: TeamsGraphResource;
  /** Channel members. Empty when `members_from_team` is set. */
  readonly members: TeamsGraphResource[];
  /** Set on a standard channel, whose members are the team's members. */
  readonly members_from_team?: true | undefined;
  /** Raw Graph `teamsTab` objects, with `teamsApp` expanded. */
  readonly tabs: TeamsGraphResource[];
  /** Teams a shared channel is shared with, from `/channels/{id}/sharedWithTeams`. */
  readonly shared_with_teams?: TeamsGraphResource[] | undefined;
  readonly files_folder?: TeamsFilesFolderRef | undefined;
  /** Set when Graph refused the Files folder (403). Not retried until a `--full` run. */
  readonly files_folder_unavailable?: true | undefined;
  readonly read_mode: TeamsChannelReadMode;
  /** Threads keyed by the channel-root message ID. */
  readonly threads: Record<string, TeamsThread>;
}

/**
 * Delta state of one channel. Saved only after the index that lists the shard it was read against.
 */
export interface TeamsChannelCursor {
  readonly format_version: typeof TEAMS_FORMAT_VERSION;
  readonly team_id: string;
  readonly channel_id: string;
  /** Message delta link. Absent for a channel that must be read in full. */
  readonly delta_link?: string | undefined;
  /**
   * Shard key the link was read against. The link is trusted only while the newest readable index
   * still lists this shard for the channel, so a snapshot written by another run cannot leave the
   * link pointing at changes the shard never saw.
   */
  readonly baseline_shard_key: string;
  /** This channel's failed roots, keyed by root ID, with attempt counts. */
  readonly failed_roots?: FailedItemLedger | undefined;
  readonly updated_at: string;
}
