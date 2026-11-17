/** Raw Graph contact JSON. Kept untyped past `id` so a backup preserves every property Graph returns. */
export type GraphContactPayload = Readonly<Record<string, unknown>> & { readonly id: string };

export interface GraphContactFolder {
  readonly id: string;
  readonly display_name: string;
  /** Display-name chain below the default Contacts folder; empty for the default folder. */
  readonly path: readonly string[];
}

export interface ContactFolderDelta {
  readonly upserted: readonly GraphContactPayload[];
  readonly removed_ids: readonly string[];
  readonly delta_link: string;
  /**
   * True when the stored delta link was rejected and the folder was re-read from scratch.
   * `upserted` is then the complete folder content and anything absent from it is gone.
   */
  readonly reset: boolean;
}

/** Graph access for a mailbox's personal contacts. Every method takes `(tenant_id, mailbox_id, ...)`. */
export interface ContactsConnector {
  /** Lists the default Contacts folder first, then every descendant folder. */
  list_contact_folders(tenant_id: string, mailbox_id: string): Promise<GraphContactFolder[]>;

  /** Reads one folder's contact changes since `delta_link`, or the full folder when absent. */
  fetch_contact_delta(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    delta_link?: string,
  ): Promise<ContactFolderDelta>;

  /** Returns the contact's photo bytes, or `undefined` when the contact has none. */
  fetch_contact_photo(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    contact_id: string,
  ): Promise<Uint8Array | undefined>;

  /** Lists the contacts currently in a folder, used by restore to detect existing contacts. */
  list_folder_contacts(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
  ): Promise<GraphContactPayload[]>;

  /** Creates a child folder under `parent_folder_id` and returns it. */
  create_contact_folder(
    tenant_id: string,
    mailbox_id: string,
    parent_folder_id: string,
    display_name: string,
  ): Promise<GraphContactFolder>;

  /** Creates a contact in a folder and returns its new ID. */
  create_contact(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<string>;

  /** Sets a contact's photo. */
  upload_contact_photo(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    contact_id: string,
    photo: Uint8Array,
  ): Promise<void>;
}
