import type { BucketStats, MailboxStats, DriveStats } from '@/domain/stats';

export interface StatsUseCase {
  get_bucket_stats(tenant_id: string): Promise<BucketStats>;
  get_mailbox_stats(tenant_id: string, owner_id: string): Promise<MailboxStats>;
  /** Aggregates OneDrive backup statistics, optionally scoped to one owner. */
  get_onedrive_stats(tenant_id: string, owner_id?: string): Promise<DriveStats>;
  /** Aggregates SharePoint backup statistics, optionally scoped to one site. */
  get_sharepoint_stats(tenant_id: string, site_id?: string): Promise<DriveStats>;
}
