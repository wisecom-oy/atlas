import type { AttachmentEntry, MailboxPurpose, Manifest } from '@/domain/manifest';

export interface MailboxSummary {
  readonly owner_id: string;
  /** Purpose from the newest manifest that recorded one; 'shared' = shared mailbox. Absent when never recorded. */
  readonly mailbox_purpose?: MailboxPurpose;
  readonly snapshot_count: number;
  readonly total_objects: number;
  readonly total_size_bytes: number;
  readonly last_backup_at: Date;
}

/**
 * A decrypted stored message. MIME entries (`payload_format: 'mime'`) expose the
 * RFC 5322 bytes in `raw` and carry no `message` object and no separate
 * attachments — their attachments are embedded in the MIME. Legacy Graph JSON
 * entries expose the parsed payload in `message` plus manifest attachments.
 */
export interface ReadMessageResult {
  /** Decrypted blob exactly as stored; always present. */
  readonly raw: Buffer;
  /** Parsed Graph JSON payload; absent for MIME entries. */
  readonly message?: Record<string, unknown>;
  readonly attachments: AttachmentEntry[];
  /** 'mime' = `raw` is RFC 5322 MIME. Absent = legacy Graph JSON payload. */
  readonly payload_format?: 'mime' | undefined;
}

export interface CatalogUseCase {
  list_mailboxes(tenant_id: string): Promise<MailboxSummary[]>;
  list_snapshots(tenant_id: string, owner_id: string): Promise<Manifest[]>;
  get_snapshot_detail(tenant_id: string, snapshot_id: string): Promise<Manifest | undefined>;
  read_message(
    tenant_id: string,
    snapshot_id: string,
    message_ref: string,
  ): Promise<ReadMessageResult | undefined>;
}
