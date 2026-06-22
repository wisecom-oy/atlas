/**
 * Decorator around RestoreConnector that records every Graph API request to
 * the active GraphRequestCounter (if any).
 *
 * All restore operations target the Outlook service pool (Exchange Online mail,
 * folder, and attachment endpoints). upload_bytes is populated for attachment
 * uploads to track against the Outlook 150 MB / 5-minute upload window.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */

import type { RestoreConnector, AttachmentUpload, UploadSession } from '@atlas/types';
import type { MailFolder } from '@atlas/types';
import { get_active_counter } from '@atlas/core/services/shared/graph-request-context';

export class CostTrackingRestoreConnector implements RestoreConnector {
  private readonly _inner: RestoreConnector;

  constructor(inner: RestoreConnector) {
    this._inner = inner;
  }

  async create_mail_folder(
    tenant_id: string,
    owner_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<MailFolder> {
    get_active_counter()?.record('outlook', 'create_folder');
    return this._inner.create_mail_folder(tenant_id, owner_id, display_name, parent_folder_id);
  }

  async create_message(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    message_body: Record<string, unknown>,
  ): Promise<string> {
    get_active_counter()?.record('outlook', 'create_message');
    return this._inner.create_message(tenant_id, owner_id, folder_id, message_body);
  }

  async add_attachment(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void> {
    get_active_counter()?.record('outlook', 'add_attachment', {
      upload_bytes: attachment.content.length,
    });
    return this._inner.add_attachment(tenant_id, owner_id, message_id, attachment);
  }

  async create_upload_session(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    file_name: string,
    file_size: number,
  ): Promise<UploadSession> {
    get_active_counter()?.record('outlook', 'create_upload_session');
    return this._inner.create_upload_session(tenant_id, owner_id, message_id, file_name, file_size);
  }

  async upload_attachment_chunk(
    upload_url: string,
    chunk: Buffer,
    range_start: number,
    total_size: number,
  ): Promise<void> {
    get_active_counter()?.record('outlook', 'upload_chunk', {
      upload_bytes: chunk.length,
    });
    return this._inner.upload_attachment_chunk(upload_url, chunk, range_start, total_size);
  }

  async count_folder_messages(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
  ): Promise<number> {
    get_active_counter()?.record('outlook', 'count_folder_messages');
    return this._inner.count_folder_messages(tenant_id, owner_id, folder_id);
  }

  async list_folder_messages(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    top: number,
  ): Promise<Array<{ subject: string; is_draft: boolean }>> {
    get_active_counter()?.record('outlook', 'list_folder_messages');
    return this._inner.list_folder_messages(tenant_id, owner_id, folder_id, top);
  }
}
