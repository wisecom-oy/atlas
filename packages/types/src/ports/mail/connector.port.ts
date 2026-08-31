import type { MailboxPurpose } from '@/domain/manifest';

export interface MailFolder {
  readonly folder_id: string;
  /** Leaf name as shown in Outlook, e.g. `2026`. */
  readonly display_name: string;
  /** Root-relative path with `/` between levels, e.g. `Inbox/Projects/2026`. */
  readonly folder_path: string;
  readonly parent_folder_id?: string | undefined;
  readonly total_item_count: number;
  /**
   * Exchange marks this folder hidden, so Outlook does not show it. Recorded
   * because a restored tree should not silently promote a hidden folder into a
   * visible one. Absent on manifests written before hidden folders were
   * enumerated at all.
   */
  readonly is_hidden?: boolean;
  /**
   * This folder lives in the Exchange Recoverable Items subtree, so its items
   * were deleted or are held rather than sitting in the visible mailbox. Kept
   * on the folder and on every entry it produces, because a restore must not
   * put deleted mail back by accident (issue #141).
   */
  readonly is_recoverable_items?: boolean;
}

/**
 * Why a folder was left out of a backup.
 *
 * - `junk-excluded`: the operator asked for Junk Email to be skipped.
 * - `hidden-system-folder`: an Exchange-hidden folder holding client state
 *   rather than mail, such as `Conversation Action Settings`.
 */
export type FolderExclusionReason =
  | 'junk-excluded'
  | 'hidden-system-folder'
  /** A Recoverable Items subfolder whose items are not mail: Versions, Calendar Logging, Audits. */
  | 'recoverable-items-not-mail'
  /** A Recoverable Items subfolder Atlas does not know, reported rather than guessed at. */
  | 'recoverable-items-unrecognised';

export interface ExcludedFolder {
  /** Root-relative path, matching {@link MailFolder.folder_path}. */
  readonly folder_path: string;
  readonly reason: FolderExclusionReason;
}

export interface MailFolderListOptions {
  /**
   * Skip Junk Email and its subtree. Junk is backed up by default: it is
   * evidence in a phishing or BEC investigation, and dropping it silently is
   * how a backup product ends up unable to answer "was it captured?".
   */
  readonly exclude_junk?: boolean;
  /**
   * Called once per pruned folder. The manifest records these, so a gap in a
   * backup is answerable from the backup itself rather than from the flags
   * whoever ran it happened to pass.
   */
  readonly on_excluded?: (excluded: ExcludedFolder) => void;
  /**
   * Also enumerate the Recoverable Items subtree: hard-deleted mail and items
   * kept only by a litigation hold or retention policy. Off by default, since
   * on a mailbox under hold the dumpster can rival the mailbox in size and
   * that cost should be a decision rather than a surprise.
   */
  readonly include_recoverable_items?: boolean;
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
  mailbox_exists(tenant_id: string, owner_id: string): Promise<boolean>;

  /**
   * Resolves the mailbox purpose (user/shared/...) via mailboxSettings.
   * Optional: absent or resolving undefined means unknown; callers must treat both the same.
   */
  // ponytail: optional method — keeps ~10 existing MailboxConnector test literals compiling; make it required if a second caller ever needs it guaranteed
  get_mailbox_purpose?(tenant_id: string, owner_id: string): Promise<MailboxPurpose | undefined>;

  list_mail_folders(
    tenant_id: string,
    owner_id: string,
    options?: MailFolderListOptions,
  ): Promise<MailFolder[]>;

  /**
   * Fetches messages changed since the previous delta link.
   * Pass the full @odata.deltaLink URL from a prior sync, or omit for a full initial sync.
   * The optional on_page callback is invoked after each page for progress reporting.
   */
  fetch_delta(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    prev_delta_link?: string | undefined,
    on_page?: DeltaPageCallback | undefined,
    page_size?: number | undefined,
  ): Promise<DeltaSyncResult>;

  fetch_message(tenant_id: string, owner_id: string, message_id: string): Promise<MailMessage>;

  /**
   * Fetches the message's RFC 5322 MIME via `GET /messages/{id}/$value` — the
   * bytes that transited SMTP, including the Received chain, DKIM/SPF results,
   * threading headers, and any S/MIME payload. Attachments are embedded.
   * Resolves undefined when Graph cannot produce MIME for the item, so callers
   * fall back to the JSON payload rather than losing the message (issue #50).
   */
  // ponytail: optional method — keeps existing MailboxConnector test literals compiling; make it required when a second caller needs it guaranteed
  fetch_mime?(tenant_id: string, owner_id: string, message_id: string): Promise<Buffer | undefined>;

  /** Fetches file attachments for a message, decoding contentBytes from base64. */
  fetch_attachments(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]>;
}
