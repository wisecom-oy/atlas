import type { MailboxPurpose } from '@/domain/manifest';

export interface TenantMailbox {
  readonly user_id: string;
  readonly mail: string;
  readonly display_name: string;
  readonly has_exchange_license: boolean;
  readonly exchange_plan_status?: string;
  /** Graph userPurpose; only resolved for unlicensed mailboxes during discovery. */
  readonly mailbox_purpose?: MailboxPurpose;
  readonly created_at?: Date;
  readonly mailbox_size_bytes?: number;
  readonly item_count?: number;
  /**
   * Whether the mailbox has an In-Place Archive (Online Archive) enabled, from
   * the `Has Archive` column of the mailbox usage report.
   *
   * `undefined` means unknown, not absent: the report needs `Reports.Read.All`
   * and the column is missing from some report revisions. Archive content is
   * outside backup scope, so reporting "no archive" for a mailbox that has one
   * is the failure worth avoiding.
   */
  readonly has_in_place_archive?: boolean;
}

export interface MailboxDiscoveryOptions {
  /** When true, only return mailboxes with an active Exchange Online license. */
  licensed_only?: boolean;
}

export interface MailboxDiscoveryService {
  list_tenant_mailboxes(
    tenant_id: string,
    options?: MailboxDiscoveryOptions,
  ): Promise<TenantMailbox[]>;
}
