import type { ExcludedFolder } from '@/ports/mail/connector.port';
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
  readonly entries: ManifestEntry[];
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
