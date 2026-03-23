export interface MailFolder {
  readonly folder_id: string;
  readonly display_name: string;
  readonly parent_folder_id?: string | undefined;
  readonly total_item_count: number;
}

export interface MailMessage {
  readonly message_id: string;
  readonly folder_id: string;
  readonly subject: string;
  readonly received_at: Date;
  readonly size_bytes: number;
  readonly raw_body: Buffer;
  readonly has_attachments: boolean;
}

export interface DeltaSyncResult {
  readonly messages: MailMessage[];
  /** IDs of messages deleted or moved out of this folder since the last sync. */
  readonly removed_ids: string[];
  /** Full @odata.deltaLink URL to pass to the next sync call. */
  readonly delta_link: string;
  /** True when the previous delta link was invalid and a full re-enumeration occurred. */
  readonly delta_reset: boolean;
}

/**
 * Called after each delta page with the page's converted messages.
 * Process messages inline for streaming. Return false to abort paging.
 */
export type DeltaPageCallback = (
  page_num: number,
  items_so_far: number,
  page_messages: MailMessage[],
) => Promise<boolean> | boolean | void;

export interface MessageAttachment {
  readonly attachment_id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly is_inline: boolean;
  readonly content: Buffer;
  readonly content_id: string;
}

export interface MailboxConnector {
  list_mailboxes(tenant_id: string): Promise<string[]>;

  /** Returns true if the mailbox exists in the tenant, false otherwise. */
  mailbox_exists(tenant_id: string, mailbox_id: string): Promise<boolean>;

  list_mail_folders(tenant_id: string, mailbox_id: string): Promise<MailFolder[]>;

  /**
   * Fetches messages changed since the previous delta link.
   * Pass the full @odata.deltaLink URL from a prior sync, or omit for a full initial sync.
   * The optional on_page callback is invoked after each page for progress reporting.
   */
  fetch_delta(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    prev_delta_link?: string | undefined,
    on_page?: DeltaPageCallback | undefined,
    page_size?: number | undefined,
  ): Promise<DeltaSyncResult>;

  fetch_message(tenant_id: string, mailbox_id: string, message_id: string): Promise<MailMessage>;

  /** Fetches file attachments for a message, decoding contentBytes from base64. */
  fetch_attachments(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]>;
}
