import type { MailboxConfigSource } from '@/domain/mailbox-config';

/** Reads and writes inbox rules, master categories, and mailbox settings. */
export interface MailboxConfigConnector {
  /** Reads all three payloads; a 403 surfaces as an AuthError naming MailboxSettings.Read. */
  fetch_mailbox_config(tenant_id: string, owner_id: string): Promise<MailboxConfigSource>;
  create_master_category(
    tenant_id: string,
    owner_id: string,
    category: Record<string, unknown>,
  ): Promise<void>;
  update_master_category_color(
    tenant_id: string,
    owner_id: string,
    category_id: string,
    color: string,
  ): Promise<void>;
  update_mailbox_settings(
    tenant_id: string,
    owner_id: string,
    settings: Record<string, unknown>,
  ): Promise<void>;
  create_message_rule(
    tenant_id: string,
    owner_id: string,
    rule: Record<string, unknown>,
  ): Promise<void>;
  update_message_rule(
    tenant_id: string,
    owner_id: string,
    rule_id: string,
    rule: Record<string, unknown>,
  ): Promise<void>;
}
