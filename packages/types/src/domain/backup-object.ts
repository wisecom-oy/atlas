export interface BackupObject {
  readonly id: string;
  readonly snapshot_id: string;
  readonly owner_id: string;
  readonly message_id: string;
  readonly folder_id: string;
  readonly subject: string;
  readonly received_at: Date;
  readonly size_bytes: number;
  readonly storage_key: string;
  readonly checksum: string;
}
