import type { ExcludedFolder, MailFolder } from '@/ports/mail/connector.port';
/** Mailbox purpose from Graph mailboxSettings.userPurpose. 'shared' identifies shared mailboxes. */
export type MailboxPurpose = 'user' | 'linked' | 'shared' | 'room' | 'equipment' | 'others';

export type ManifestObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface ManifestObjectLockRequestedPolicy {
  readonly mode?: ManifestObjectLockMode | undefined;
  readonly retention_days?: number | undefined;
}

export interface ManifestObjectLockEffectivePolicy {
  readonly mode?: ManifestObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface ManifestObjectLockPolicy {
  readonly requested: ManifestObjectLockRequestedPolicy;
  readonly effective: ManifestObjectLockEffectivePolicy;
}

export interface Manifest {
  readonly id: string;
  readonly tenant_id: string;
  /** Entra object ID (UUID) of the mailbox owner; used as the storage partition key. */
  readonly owner_id: string;
  /** Graph mailboxSettings.userPurpose at backup time; 'shared' = shared mailbox. Absent on pre-feature manifests or when the lookup failed. */
  readonly mailbox_purpose?: MailboxPurpose;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly total_objects: number;
  readonly total_size_bytes: number;
  /** Maps folder_id -> full @odata.deltaLink URL for the next incremental sync. */
  readonly delta_links: Record<string, string>;
  /**
   * ID format the delta links and entry IDs were captured with. Absent means
   * legacy mutable IDs — the next sync must restart full (issue #48).
   */
  readonly id_format?: 'immutable' | undefined;
  readonly object_lock?: ManifestObjectLockPolicy;
  /**
   * Folders this run did not capture, with why. Absent means nothing was
   * excluded, or the manifest predates the field; a backup should be able to
   * answer "was folder X captured?" without knowing which flags were passed.
   */
  readonly excluded_folders?: ExcludedFolder[];
  /**
   * Folders this run selected for capture, with path and well-known role, so
   * a snapshot can be browsed by folder without the live mailbox. An
   * incremental manifest lists this run's folders; entries carried from older
   * snapshots may name a folder only an older manifest lists. Absent on
   * manifests written before the field.
   */
  readonly folders?: MailFolder[] | undefined;
  readonly entries: ManifestEntry[];
}

/** A mail address as Graph `emailAddress` reports it. */
export interface MailAddress {
  readonly name?: string | undefined;
  readonly address: string;
}

export interface AttachmentEntry {
  readonly attachment_id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly storage_key: string;
  readonly checksum: string;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

export interface ManifestEntry {
  readonly object_id: string;
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly subject?: string;
  readonly folder_id?: string;
  /**
   * Graph `from`, the sender Outlook shows, including for delegated and
   * send-as mail. Absent when Graph reports none (drafts, some system items)
   * and on entries written before the field existed.
   */
  readonly from?: MailAddress | undefined;
  /**
   * File attachments stored as separate content-addressed objects. Only JSON
   * entries carry these; MIME entries embed their attachments in the blob.
   */
  readonly attachments?: AttachmentEntry[];
  /**
   * Format of the stored blob. 'mime' means the RFC 5322 MIME Graph returned
   * from /$value, byte-for-byte as it transited SMTP. Absent means the legacy
   * Graph JSON payload, which is a lossy reconstruction (issue #50).
   */
  readonly payload_format?: 'mime' | undefined;
  /**
   * ISO 8601 receive timestamp. Recorded for MIME entries, which have no JSON
   * payload to read `receivedDateTime` from.
   */
  readonly received_at?: string | undefined;
  /**
   * Captured from the Recoverable Items subtree rather than the visible
   * mailbox. Marked on the entry, not inferred from the folder path, because a
   * user folder can be named anything and this decides whether a restore
   * writes the item back (issue #141).
   */
  readonly recoverable_items?: boolean | undefined;
}

/**
 * A mailbox's folder delta links, kept outside the snapshot manifests.
 *
 * Manifests carried these until v5.1.0, which meant a run that changed nothing still had to
 * write a whole snapshot object to record where each folder's delta stopped, so a quiet mailbox
 * grew one manifest per run forever. A snapshot is immutable once written, so rewriting the head
 * was not an option: the links moved to a cursor the run overwrites, the way the drive providers
 * have always done it (issue #370).
 */
export interface MailboxDeltaCursor {
  readonly owner_id: string;
  /** Delta link per Graph folder id, for folders whose last pass completed. */
  readonly delta_links: Record<string, string>;
  readonly updated_at: string;
}
