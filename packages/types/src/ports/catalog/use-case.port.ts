import type { AttachmentEntry, Manifest } from '@/domain/manifest';

export interface MailboxSummary {
  readonly owner_id: string;
  readonly snapshot_count: number;
  readonly total_objects: number;
  readonly total_size_bytes: number;
  readonly last_backup_at: Date;
}

export interface ReadMessageResult {
  readonly message: Record<string, unknown>;
  readonly attachments: AttachmentEntry[];
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
