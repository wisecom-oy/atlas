import type { BucketStats, MailboxStats } from '@/domain/stats';

export interface StatsUseCase {
  get_bucket_stats(tenant_id: string): Promise<BucketStats>;
  get_mailbox_stats(tenant_id: string, mailbox_id: string): Promise<MailboxStats>;
}
