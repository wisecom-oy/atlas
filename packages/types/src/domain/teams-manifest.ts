import type { FailedItemLedger } from '@/domain/failed-item';

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

/**
 * The encrypted body of one thread blob: a channel root message and all its replies, as Graph
 * returned them. Deleted replies stay in `replies` with `deletedDateTime` set and an empty body.
 */
export interface TeamsThreadBlob {
  readonly root: TeamsGraphResource;
  readonly replies: TeamsGraphResource[];
}

/** A stored blob's location and integrity data, shared by thread and hosted-content records. */
export interface TeamsStoredBlobRef {
  /** Key of the encrypted blob. Derived from the keyed content name, not the plaintext hash. */
  readonly storage_key: string;
  /** Plain SHA-256 of the plaintext, checked by verification. */
  readonly checksum: string;
  readonly size_bytes: number;
}

/** An inline image or other `hostedContents` item, stored as raw bytes. */
export interface TeamsHostedContentRef extends TeamsStoredBlobRef {
  /** Graph `chatMessageHostedContent` `contentType`, when Graph reports one. */
  readonly content_type?: string | undefined;
}

/** One channel-root thread as recorded in a snapshot. */
export interface TeamsThreadEntry extends TeamsStoredBlobRef {
  /** Graph `lastModifiedDateTime` of the root. Does not move when a reply changes. */
  readonly last_modified_at: string;
  /** Number of replies stored in the thread blob, deleted replies included. */
  readonly reply_count: number;
  /** Hosted-content ID (root or reply) to its stored blob. */
  readonly hosted: Record<string, TeamsHostedContentRef>;
  /**
   * Set when Graph reports the root removed. The entry keeps the blob it had: the tombstone
   * when Graph returned one, otherwise the last live blob. See `last_live`.
   */
  readonly deleted_at?: string | undefined;
  /** The last live thread blob, kept once the root is deleted so its replies stay restorable. */
  readonly last_live?: TeamsStoredBlobRef | undefined;
  readonly backup_at: string;
}

/** A thread entry together with its position in the snapshot, for flat listings. */
export interface TeamsThreadListing extends TeamsThreadEntry {
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

export interface TeamsChannelEntry {
  readonly id: string;
  /** Raw Graph channel object, including `membershipType` and `email`. */
  readonly channel: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  /** Raw Graph `teamsTab` objects, with `teamsApp` expanded. */
  readonly tabs: TeamsGraphResource[];
  readonly files_folder?: TeamsFilesFolderRef | undefined;
  /** Set when Graph refused the Files folder (403). Not retried until a `--full` run. */
  readonly files_folder_unavailable?: true | undefined;
  /** Set when Graph reports the channel gone. The entry is kept and its delta link dropped. */
  readonly deleted_at?: string | undefined;
  /** Teams a shared channel is shared with, from `/channels/{id}/sharedWithTeams`. */
  readonly shared_with_teams?: TeamsGraphResource[] | undefined;
  readonly read_mode: TeamsChannelReadMode;
  /** Thread entries keyed by the channel-root message ID. */
  readonly threads: Record<string, TeamsThreadEntry>;
}

export interface TeamsSnapshotManifest {
  /** `${team_id}-${snapshot_id}`, matching the SharePoint manifest id convention. */
  readonly id: string;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name?: string | undefined;
  readonly snapshot_id: string;
  readonly created_at: Date;
  /** Raw Graph team object (`/teams/{id}`), settings included. */
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  readonly channels: TeamsChannelEntry[];
  readonly total_threads: number;
  readonly total_size_bytes: number;
}

/** Per-team delta state. Saved only after the manifest that the links were read against. */
export interface TeamsDeltaCursor {
  readonly team_id: string;
  /** `snapshot_id` of the manifest the links were read against. A mismatch forces a full read. */
  readonly snapshot_id?: string | undefined;
  /** Message delta link per channel ID. Absent for a channel that must be read in full. */
  readonly delta_link_by_channel: Record<string, string>;
  /**
   * Roots whose backup failed, keyed by `${channel_id}/${root_id}`, with their attempt count.
   * `drive_id` holds the channel ID. A channel with an unexhausted record keeps its previous link.
   */
  readonly failed_roots?: FailedItemLedger | undefined;
  readonly updated_at: string;
}
