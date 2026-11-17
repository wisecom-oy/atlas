import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  ContactFolderDelta,
  ContactsConnector,
  GraphContactFolder,
  GraphContactPayload,
} from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import { fetch_folder_delta } from '@/adapters/graph-contacts-delta';
import { create_contact_folder, list_contact_folders } from '@/adapters/graph-contacts-folders';
import {
  create_contact,
  fetch_contact_photo,
  list_folder_contacts,
  upload_contact_photo,
} from '@/adapters/graph-contacts-items';

/** Microsoft Graph implementation of the personal contacts connector. */
@injectable()
export class GraphContactsConnector implements ContactsConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists the default Contacts folder first, then every descendant folder. */
  async list_contact_folders(
    _tenant_id: string,
    mailbox_id: string,
  ): Promise<GraphContactFolder[]> {
    return list_contact_folders(this._client, mailbox_id);
  }

  /** Reads one folder's contact changes since `delta_link`, or the full folder when absent. */
  async fetch_contact_delta(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    delta_link?: string,
  ): Promise<ContactFolderDelta> {
    return fetch_folder_delta(this._client, mailbox_id, folder_id, delta_link);
  }

  /** Returns the contact's photo bytes, or `undefined` when the contact has none. */
  async fetch_contact_photo(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    contact_id: string,
  ): Promise<Uint8Array | undefined> {
    return fetch_contact_photo(this._client, mailbox_id, folder_id, contact_id);
  }

  /** Lists the contacts currently in a folder. */
  async list_folder_contacts(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
  ): Promise<GraphContactPayload[]> {
    return list_folder_contacts(this._client, mailbox_id, folder_id);
  }

  /** Creates a child folder under `parent_folder_id`. */
  async create_contact_folder(
    _tenant_id: string,
    mailbox_id: string,
    parent_folder_id: string,
    display_name: string,
  ): Promise<GraphContactFolder> {
    return create_contact_folder(this._client, mailbox_id, parent_folder_id, display_name);
  }

  /** Creates a contact in a folder and returns its new id. */
  async create_contact(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    return create_contact(this._client, mailbox_id, folder_id, payload);
  }

  /** Sets a contact's photo. */
  async upload_contact_photo(
    _tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    contact_id: string,
    photo: Uint8Array,
  ): Promise<void> {
    return upload_contact_photo(this._client, mailbox_id, folder_id, contact_id, photo);
  }
}
