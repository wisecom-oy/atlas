export interface TenantMailbox {
  readonly user_id: string;
  readonly mail: string;
  readonly display_name: string;
  readonly has_exchange_license: boolean;
  readonly exchange_plan_status?: string;
  readonly created_at?: Date;
  readonly mailbox_size_bytes?: number;
  readonly item_count?: number;
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
