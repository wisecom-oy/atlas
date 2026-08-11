/**
 * Decorator around RestoreConnector that labels every Graph request a restore
 * makes, so the transport-level cost counter can charge it correctly.
 *
 * All restore operations target the Outlook service pool (Exchange Online mail,
 * folder, and attachment endpoints). Upload bytes are measured at the transport
 * from the request body rather than declared here: a resumable chunk that is
 * retried is sent twice, and the tenant's 150 MB / 5-minute upload window is
 * charged twice for it.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */

import type { RestoreConnector, AttachmentUpload, UploadSession } from '@wisecom/atlas-types';
import type { MailFolder } from '@wisecom/atlas-types';
import { run_with_graph_operation } from '@wisecom/atlas-core/services/shared/graph-request-context';

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
    return run_with_graph_operation({ pool: 'outlook', request_type: 'create_folder' }, () =>
      this._inner.create_mail_folder(tenant_id, owner_id, display_name, parent_folder_id),
    );
  }

  async create_message(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    message_body: Record<string, unknown>,
  ): Promise<string> {
    return run_with_graph_operation({ pool: 'outlook', request_type: 'create_message' }, () =>
      this._inner.create_message(tenant_id, owner_id, folder_id, message_body),
    );
  }

  async add_attachment(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void> {
    return run_with_graph_operation({ pool: 'outlook', request_type: 'add_attachment' }, () =>
      this._inner.add_attachment(tenant_id, owner_id, message_id, attachment),
    );
  }

  async create_upload_session(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    file_name: string,
    file_size: number,
  ): Promise<UploadSession> {
    return run_with_graph_operation(
      { pool: 'outlook', request_type: 'create_upload_session' },
      () =>
        this._inner.create_upload_session(tenant_id, owner_id, message_id, file_name, file_size),
    );
  }

  async upload_attachment_chunk(
    upload_url: string,
    chunk: Buffer,
    range_start: number,
    total_size: number,
  ): Promise<void> {
    return run_with_graph_operation({ pool: 'outlook', request_type: 'upload_chunk' }, () =>
      this._inner.upload_attachment_chunk(upload_url, chunk, range_start, total_size),
    );
  }

  async count_folder_messages(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
  ): Promise<number> {
    return run_with_graph_operation(
      { pool: 'outlook', request_type: 'count_folder_messages' },
      () => this._inner.count_folder_messages(tenant_id, owner_id, folder_id),
    );
  }

  async list_folder_messages(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    top: number,
  ): Promise<Array<{ subject: string; is_draft: boolean }>> {
    return run_with_graph_operation({ pool: 'outlook', request_type: 'list_folder_messages' }, () =>
      this._inner.list_folder_messages(tenant_id, owner_id, folder_id, top),
    );
  }
}
