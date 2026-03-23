import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';
import type {
  RestoreConnector,
  AttachmentUpload,
  UploadSession,
} from '@/ports/restore/connector.port';
import type { MailFolder } from '@/ports/mailbox/connector.port';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from './graph-error-helpers';
import { logger } from '@/utils/logger';

const LARGE_ATTACHMENT_THRESHOLD = 3 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

interface GraphFolderResponse {
  id?: string;
  displayName?: string;
  parentFolderId?: string;
  totalItemCount?: number;
}

interface GraphMessageResponse {
  id?: string;
}

interface GraphUploadSessionResponse {
  uploadUrl?: string;
  expirationDateTime?: string;
}

@injectable()
export class GraphRestoreConnector implements RestoreConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Creates a mail folder at top-level or under a parent folder. */
  async create_mail_folder(
    _tenant_id: string,
    mailbox_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<MailFolder> {
    const url = parent_folder_id
      ? `/users/${mailbox_id}/mailFolders/${parent_folder_id}/childFolders`
      : `/users/${mailbox_id}/mailFolders`;

    try {
      const response = (await with_graph_retry(() =>
        this._client.api(url).post({ displayName: display_name }),
      )) as GraphFolderResponse;

      return {
        folder_id: response.id ?? '',
        display_name: response.displayName ?? display_name,
        parent_folder_id: response.parentFolderId ?? parent_folder_id,
        total_item_count: response.totalItemCount ?? 0,
      };
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Creates a message in the target folder. Returns the new Graph message ID. */
  async create_message(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    message_body: Record<string, unknown>,
  ): Promise<string> {
    const url = `/users/${mailbox_id}/mailFolders/${folder_id}/messages`;

    try {
      const response = (await with_graph_retry(() =>
        this._client.api(url).post(message_body),
      )) as GraphMessageResponse;

      if (!response.id) throw new Error('Graph returned no message ID after create');
      return response.id;
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Uploads a small attachment inline (<3 MB) or delegates to upload session. */
  async add_attachment(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void> {
    if (attachment.content.length >= LARGE_ATTACHMENT_THRESHOLD) {
      await this.upload_large_attachment(tenant_id, mailbox_id, message_id, attachment);
      return;
    }

    const url = `/users/${mailbox_id}/messages/${message_id}/attachments`;
    const payload: Record<string, unknown> = {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.name,
      contentType: attachment.content_type,
      contentBytes: attachment.content.toString('base64'),
      isInline: attachment.is_inline,
    };

    if (attachment.content_id) {
      payload['contentId'] = attachment.content_id;
    }

    try {
      await with_graph_retry(() => this._client.api(url).post(payload));
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Opens an upload session for a large attachment. */
  async create_upload_session(
    _tenant_id: string,
    mailbox_id: string,
    message_id: string,
    file_name: string,
    file_size: number,
  ): Promise<UploadSession> {
    const url = `/users/${mailbox_id}/messages/${message_id}/attachments/createUploadSession`;
    const payload = {
      AttachmentItem: {
        attachmentType: 'file',
        name: file_name,
        size: file_size,
      },
    };

    try {
      const response = (await with_graph_retry(() =>
        this._client.api(url).post(payload),
      )) as GraphUploadSessionResponse;

      if (!response.uploadUrl) throw new Error('Graph returned no uploadUrl for session');
      return { upload_url: response.uploadUrl, expiration: response.expirationDateTime ?? '' };
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Uploads a single chunk to an active upload session via PUT. */
  async upload_attachment_chunk(
    upload_url: string,
    chunk: Buffer,
    range_start: number,
    total_size: number,
  ): Promise<void> {
    const range_end = range_start + chunk.length - 1;
    const content_range = `bytes ${range_start}-${range_end}/${total_size}`;

    await with_graph_retry(() =>
      this._client
        .api(upload_url)
        .header('Content-Range', content_range)
        .header('Content-Length', String(chunk.length))
        .put(chunk),
    );
  }

  /** Returns the total message count in a folder via Graph. */
  async count_folder_messages(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
  ): Promise<number> {
    const url = `/users/${mailbox_id}/mailFolders/${folder_id}?$select=totalItemCount`;
    const response = (await with_graph_retry(() => this._client.api(url).get())) as {
      totalItemCount?: number;
    };
    return response.totalItemCount ?? 0;
  }

  /** Lists messages in a folder with basic properties. */
  async list_folder_messages(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    top: number,
  ): Promise<Array<{ subject: string; is_draft: boolean }>> {
    const url =
      `/users/${mailbox_id}/mailFolders/${folder_id}/messages` +
      `?$select=subject,isDraft&$top=${top}`;
    const response = (await with_graph_retry(() => this._client.api(url).get())) as {
      value?: Array<{ subject?: string; isDraft?: boolean }>;
    };
    return (response.value ?? []).map((m) => ({
      subject: m.subject ?? '(no subject)',
      is_draft: m.isDraft ?? true,
    }));
  }

  /** Handles large attachments by chunking through an upload session. */
  private async upload_large_attachment(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void> {
    logger.debug(
      `Large attachment "${attachment.name}" (${attachment.content.length} bytes) -- using upload session`,
    );

    const session = await this.create_upload_session(
      tenant_id,
      mailbox_id,
      message_id,
      attachment.name,
      attachment.content.length,
    );

    let offset = 0;
    while (offset < attachment.content.length) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, attachment.content.length);
      const chunk = attachment.content.subarray(offset, end);
      await this.upload_attachment_chunk(
        session.upload_url,
        chunk,
        offset,
        attachment.content.length,
      );
      offset = end;
    }
  }
}
