import type { MailFolder } from '@/ports/mailbox/connector.port';

export interface AttachmentUpload {
  readonly name: string;
  readonly content_type: string;
  readonly content: Buffer;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

export interface UploadSession {
  readonly upload_url: string;
  readonly expiration: string;
}

export interface RestoreConnector {
  /** Creates a mail folder under msgFolderRoot (top-level) or under a parent. */
  create_mail_folder(
    tenant_id: string,
    mailbox_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<MailFolder>;

  /** Creates a message in the specified folder. Returns the new message ID. */
  create_message(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    message_body: Record<string, unknown>,
  ): Promise<string>;

  /** Uploads a small attachment (<3 MB) inline as base64. */
  add_attachment(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void>;

  /** Opens an upload session for a large attachment (>=3 MB). */
  create_upload_session(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
    file_name: string,
    file_size: number,
  ): Promise<UploadSession>;

  /** Uploads a chunk to an active upload session. */
  upload_attachment_chunk(
    upload_url: string,
    chunk: Buffer,
    range_start: number,
    total_size: number,
  ): Promise<void>;

  /** Returns the total message count in a folder (for verification). */
  count_folder_messages(tenant_id: string, mailbox_id: string, folder_id: string): Promise<number>;

  /** Lists messages in a folder with basic properties (for verification). */
  list_folder_messages(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    top: number,
  ): Promise<Array<{ subject: string; is_draft: boolean }>>;
}
