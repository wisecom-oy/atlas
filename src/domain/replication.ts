export enum ReplicationStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

export enum ReplicationVerificationStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export interface ReplicationObjectResult {
  readonly storage_key: string;
  readonly outcome: 'copied' | 'skipped' | 'failed';
  readonly error?: string;
}

export interface ReplicationResult {
  readonly snapshot_id: string;
  readonly target_id: string;
  readonly status: ReplicationStatus;
  readonly objects_total: number;
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly elapsed_ms: number;
  readonly errors: string[];
  readonly verification_status: ReplicationVerificationStatus;
  readonly source_manifest_checksum?: string;
  readonly replicated_manifest_checksum?: string;
}

/** Durable sidecar record persisted at `_meta/replication/{mailbox}/{snapshot}/{target}.json`. */
export interface ReplicationStatusRecord {
  readonly target_id: string;
  readonly target_endpoint: string;
  readonly snapshot_id: string;
  readonly mailbox_id: string;
  readonly status: ReplicationStatus;
  readonly started_at: string;
  readonly completed_at?: string;
  readonly objects_total: number;
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_total: number;
  readonly bytes_copied: number;
  readonly last_error?: string;
  readonly verification_status?: ReplicationVerificationStatus;
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}
