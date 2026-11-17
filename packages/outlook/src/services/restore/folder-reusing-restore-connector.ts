/**
 * Restore connector that reuses a folder which already exists instead of creating a second one.
 *
 * A restore into a chosen destination can meet folders a previous restore left there. Graph
 * refuses a second folder with the same name under one parent, so a plain create failed for each
 * of them and their messages were reported as not restored (issue #684). Every other call passes
 * through unchanged, so the restore loop does not need to know which mode it runs in.
 *
 * A folder this connector created in the same run is new and empty, so nothing beneath it is
 * looked up: the extra GET is only paid under folders that already existed.
 */
import type {
  AttachmentUpload,
  MailFolder,
  RestoreConnector,
  UploadSession,
  WellKnownMailFolder,
} from '@wisecom/atlas-types';

/** A folder and whether this run created it or found it already there. */
export interface ResolvedMailFolder {
  readonly folder: MailFolder;
  readonly created: boolean;
}

export class FolderReusingRestoreConnector implements RestoreConnector {
  private readonly _created_folder_ids = new Set<string>();

  constructor(private readonly _inner: RestoreConnector) {}

  /** Returns the existing folder of this name under the parent, creating it only when absent. */
  async create_mail_folder(
    tenant_id: string,
    owner_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<MailFolder> {
    const resolved = await this.find_or_create_mail_folder(
      tenant_id,
      owner_id,
      display_name,
      parent_folder_id,
    );
    return resolved.folder;
  }

  /** Looks the folder up under its parent and creates it only when absent. */
  async find_or_create_mail_folder(
    tenant_id: string,
    owner_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<ResolvedMailFolder> {
    const parent_is_new =
      parent_folder_id !== undefined && this._created_folder_ids.has(parent_folder_id);
    if (!parent_is_new) {
      const existing = await this._inner.find_child_mail_folder(
        tenant_id,
        owner_id,
        display_name,
        parent_folder_id,
      );
      if (existing) return { folder: existing, created: false };
    }
    const folder = await this._inner.create_mail_folder(
      tenant_id,
      owner_id,
      display_name,
      parent_folder_id,
    );
    this._created_folder_ids.add(folder.folder_id);
    return { folder, created: true };
  }

  /** Passes through to the wrapped connector. */
  find_child_mail_folder(
    tenant_id: string,
    owner_id: string,
    display_name: string,
    parent_folder_id?: string,
  ): Promise<MailFolder | undefined> {
    return this._inner.find_child_mail_folder(tenant_id, owner_id, display_name, parent_folder_id);
  }

  /** Passes through to the wrapped connector. */
  find_well_known_folder_role(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
  ): Promise<WellKnownMailFolder | undefined> {
    return this._inner.find_well_known_folder_role(tenant_id, owner_id, folder_id);
  }

  /** Passes through to the wrapped connector. */
  create_message(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    message_body: Record<string, unknown>,
  ): Promise<string> {
    return this._inner.create_message(tenant_id, owner_id, folder_id, message_body);
  }

  /** Passes through to the wrapped connector. */
  add_attachment(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    attachment: AttachmentUpload,
  ): Promise<void> {
    return this._inner.add_attachment(tenant_id, owner_id, message_id, attachment);
  }

  /** Passes through to the wrapped connector. */
  create_upload_session(
    tenant_id: string,
    owner_id: string,
    message_id: string,
    file_name: string,
    file_size: number,
  ): Promise<UploadSession> {
    return this._inner.create_upload_session(tenant_id, owner_id, message_id, file_name, file_size);
  }

  /** Passes through to the wrapped connector. */
  upload_attachment_chunk(
    upload_url: string,
    chunk: Buffer,
    range_start: number,
    total_size: number,
  ): Promise<void> {
    return this._inner.upload_attachment_chunk(upload_url, chunk, range_start, total_size);
  }

  /** Passes through to the wrapped connector. */
  count_folder_messages(tenant_id: string, owner_id: string, folder_id: string): Promise<number> {
    return this._inner.count_folder_messages(tenant_id, owner_id, folder_id);
  }

  /** Passes through to the wrapped connector. */
  list_folder_messages(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    top: number,
  ): Promise<Array<{ subject: string; is_draft: boolean }>> {
    return this._inner.list_folder_messages(tenant_id, owner_id, folder_id, top);
  }
}
