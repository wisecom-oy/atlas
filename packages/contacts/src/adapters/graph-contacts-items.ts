import { ResponseType, type Client } from '@microsoft/microsoft-graph-client';
import type { GraphContactPayload } from '@wisecom/atlas-types';
import {
  CONTACTS_READ,
  CONTACTS_READ_WRITE,
  collect_pages,
  graph_call,
  is_not_found,
  mailbox_url,
  string_field,
} from '@/adapters/graph-contacts-requests';

function folder_contacts_url(mailbox_id: string, folder_id: string): string {
  return `${mailbox_url(mailbox_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts`;
}

function contact_url(mailbox_id: string, folder_id: string, contact_id: string): string {
  return `${folder_contacts_url(mailbox_id, folder_id)}/${encodeURIComponent(contact_id)}`;
}

/** Lists every contact currently in a folder. */
export async function list_folder_contacts(
  client: Client,
  mailbox_id: string,
  folder_id: string,
): Promise<GraphContactPayload[]> {
  return collect_pages<GraphContactPayload>(
    client,
    folder_contacts_url(mailbox_id, folder_id),
    CONTACTS_READ,
  );
}

/** Reads a contact's photo bytes; a 404 means the contact has no photo. */
export async function fetch_contact_photo(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  contact_id: string,
): Promise<Uint8Array | undefined> {
  const url = `${contact_url(mailbox_id, folder_id, contact_id)}/photo/$value`;
  try {
    const body = await graph_call<ArrayBuffer>(CONTACTS_READ, () =>
      client.api(url).responseType(ResponseType.ARRAYBUFFER).get(),
    );
    return new Uint8Array(body);
  } catch (err) {
    if (is_not_found(err)) return undefined;
    throw err;
  }
}

/** Creates a contact in a folder and returns its id. */
export async function create_contact(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created: unknown = await graph_call(CONTACTS_READ_WRITE, () =>
    client.api(folder_contacts_url(mailbox_id, folder_id)).post(payload),
  );
  return string_field(created, 'id');
}

/** Sets a contact's photo to JPEG-typed bytes. */
export async function upload_contact_photo(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  contact_id: string,
  photo: Uint8Array,
): Promise<void> {
  const url = `${contact_url(mailbox_id, folder_id, contact_id)}/photo/$value`;
  await graph_call(CONTACTS_READ_WRITE, () =>
    client.api(url).header('Content-Type', 'image/jpeg').put(Buffer.from(photo)),
  );
}
